const { pool } = require("../config/mysql");
const botStatusService = require("./botStatusService");
const {
  getConvertQuote,
  acceptConvertQuote,
  getConvertOrderStatus,
  getSpotBalance,
  getFundingBalance,
} = require("./binanceService");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  convertService — Auto-convert after a P2P order completes.
//
//  SEMANTICS (new):
//    - Target asset is FIXED = USDT (system-wide).
//    - User selects a list of SOURCE coins on the frontend (the convert_assets
//      table — rows with enabled=1 are "auto-convert me" sources).
//    - When an order completes, the bot checks: is the released asset in the
//      enabled source list? If yes → convert to USDT. If no → SKIPPED.
//
//  Flow (single attempt, no retry — per user requirement):
//    1. Skip if auto_convert_enabled = 0 in bot_config (master switch).
//    2. Skip if order asset is already USDT (nothing to convert).
//    3. Skip if order asset is NOT in the enabled convert_assets list.
//    4. Insert a PENDING row into `conversions` immediately (so the UI shows
//       the attempt even if it later fails).
//    5. Poll the spot wallet for up to ~10s to confirm the released crypto
//       has actually landed (Binance can lag 1-5s after status=COMPLETED).
//    6. Request a quote, accept it, verify orderStatus.
//    7. Update the conversions row with SUCCESS + to_amount/rate/ref ids
//       OR FAILED + error_message.
//
//  Chat messages: NONE. This module is completely silent to the seller.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_TARGET = "USDT";
// Binance can take 10-30 sec to credit the wallet after a P2P release in
// some merchant scenarios — give a generous 45-second window.
const BALANCE_POLL_TIMEOUT_MS = 45_000;
const BALANCE_POLL_INTERVAL_MS = 2_000;
// Binance deducts a small P2P merchant fee on release (typically 0.05-0.5%),
// so wallet credit is slightly LESS than the order's advertised cryptoAmount.
// We accept any balance ≥ 95% of expected as "landed", then convert whatever
// actually arrived.
const FEE_TOLERANCE = 0.95;
// After detecting the balance, wait a short extra delay so any final
// settlement updates land before we read the convert amount.
const POST_LAND_SETTLE_MS = 2_000;

// Returns true if `symbol` is in the enabled source list. False otherwise.
async function isSourceEnabled(symbol) {
  try {
    const [rows] = await pool.query(
      "SELECT id FROM convert_assets WHERE symbol = ? AND enabled = 1 LIMIT 1",
      [String(symbol).toUpperCase()]
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn("isSourceEnabled query failed", { symbol, error: err.message });
    return false;
  }
}

async function insertPending(orderNo, fromAsset, toAsset, fromAmount) {
  const [result] = await pool.query(
    `INSERT INTO conversions
       (order_no, from_asset, to_asset, from_amount, status)
     VALUES (?, ?, ?, ?, 'PENDING')`,
    [orderNo, fromAsset, toAsset, fromAmount]
  );
  return result.insertId;
}

async function markSuccess(rowId, { toAmount, rate, quoteId, orderId }) {
  await pool.query(
    `UPDATE conversions
        SET status = 'SUCCESS',
            to_amount = ?, rate = ?,
            binance_quote_id = ?, binance_order_id = ?,
            error_message = NULL
      WHERE id = ?`,
    [toAmount, rate, quoteId || null, orderId || null, rowId]
  );
}

async function markFailed(rowId, errorMessage, extras = {}) {
  await pool.query(
    `UPDATE conversions
        SET status = 'FAILED',
            error_message = ?,
            binance_quote_id = COALESCE(?, binance_quote_id),
            binance_order_id = COALESCE(?, binance_order_id)
      WHERE id = ?`,
    [String(errorMessage || "").slice(0, 500), extras.quoteId || null, extras.orderId || null, rowId]
  );
}

async function markSkipped(orderNo, fromAsset, toAsset, fromAmount, reason) {
  await pool.query(
    `INSERT INTO conversions
       (order_no, from_asset, to_asset, from_amount, status, error_message)
     VALUES (?, ?, ?, ?, 'SKIPPED', ?)`,
    [orderNo, fromAsset, toAsset || fromAsset, fromAmount, String(reason).slice(0, 500)]
  );
}

// Poll BOTH spot AND funding wallets until at least `threshold` of `asset`
// is free in one of them, or timeout. Threshold uses FEE_TOLERANCE so a
// Binance P2P fee deduction (typically 0.05-0.5%) doesn't trip a false
// "balance never arrived" failure.
//
//   For Binance merchant accounts, P2P releases are credited to the FUNDING
//   wallet by default — checking Spot only (the old behaviour) is why
//   conversions were failing with "have 0, need X".
//
// After a wallet crosses the threshold, we wait POST_LAND_SETTLE_MS and
// re-read once so the returned `available` is the final settled balance
// (which is what we'll actually convert).
//
// Returns: { walletType: 'SPOT' | 'FUNDING' | null, available: number,
//           spot: number, funding: number }
async function waitForBalance(asset, expectedAmount, timeoutMs = BALANCE_POLL_TIMEOUT_MS) {
  const threshold = expectedAmount * FEE_TOLERANCE;
  const deadline = Date.now() + timeoutMs;
  let lastSpot = 0;
  let lastFunding = 0;

  const readSpot = async () => {
    try {
      const b = await getSpotBalance(asset);
      lastSpot = b.free;
      return b.free;
    } catch (err) {
      logger.warn("convertService: spot balance poll failed (will retry)", {
        asset, error: err.message,
      });
      return 0;
    }
  };
  const readFunding = async () => {
    try {
      const b = await getFundingBalance(asset);
      lastFunding = b.free;
      return b.free;
    } catch (err) {
      logger.warn("convertService: funding balance poll failed (will retry)", {
        asset, error: err.message,
      });
      return 0;
    }
  };

  while (Date.now() < deadline) {
    const spotFree = await readSpot();
    if (spotFree >= threshold) {
      // Give Binance a moment to finish any post-release accounting, then
      // re-read so we convert the final settled amount.
      await new Promise((r) => setTimeout(r, POST_LAND_SETTLE_MS));
      const finalSpot = await readSpot();
      return {
        walletType: 'SPOT',
        available:  finalSpot >= threshold ? finalSpot : spotFree,
        spot:       finalSpot,
        funding:    lastFunding,
      };
    }
    const fundingFree = await readFunding();
    if (fundingFree >= threshold) {
      await new Promise((r) => setTimeout(r, POST_LAND_SETTLE_MS));
      const finalFunding = await readFunding();
      return {
        walletType: 'FUNDING',
        available:  finalFunding >= threshold ? finalFunding : fundingFree,
        spot:       lastSpot,
        funding:    finalFunding,
      };
    }
    await new Promise((r) => setTimeout(r, BALANCE_POLL_INTERVAL_MS));
  }

  // Timed out — return whatever the last polls saw so caller logs are useful
  return { walletType: null, available: 0, spot: lastSpot, funding: lastFunding };
}

// Main entry point — called from orderHandler.complete() right after the
// order is marked COMPLETED in stateManager. Fire-and-forget (caller does
// not await), so a slow / failing convert never blocks the order lifecycle.
async function convertAfterRelease(order) {
  const orderNo = order?.orderNo;
  const fromAsset = String(order?.asset || "").toUpperCase();
  const fromAmount = Number(order?.cryptoAmount) || 0;
  const toAsset = FIXED_TARGET;

  if (!orderNo || !fromAsset || !(fromAmount > 0)) {
    logger.debug("convertService: nothing to convert (missing fields)", {
      orderNo, fromAsset, fromAmount,
    });
    return;
  }

  // ── Gate 0: Master bot kill-switch (bot_status) ────────────────────────────
  //   When the operator toggles Bot Status OFF from the Overview page, the
  //   entire bot is considered paused — including auto-convert. This is the
  //   first gate, ahead of even the auto-convert toggle.
  let botEnabled = false;
  try {
    botEnabled = await botStatusService.isBotEnabled();
  } catch (err) {
    logger.warn("convertService: failed to read bot_status — assuming OFF, skipping", {
      orderNo, error: err.message,
    });
    return;
  }
  if (!botEnabled) {
    logger.info("convertService: bot is OFF — conversion suppressed", { orderNo });
    return;
  }

  // ── Gate 1: Auto-convert master switch (auto_convert_enabled) ──────────────
  let enabled = false;
  try {
    enabled = await botStatusService.isAutoConvertEnabled();
  } catch (err) {
    logger.warn("convertService: failed to read auto_convert_enabled — skipping", {
      orderNo, error: err.message,
    });
    return;
  }
  if (!enabled) {
    logger.info("convertService: auto-convert disabled — skipping", { orderNo });
    return;
  }

  // ── Gate 2: Source equals target (USDT → USDT is a no-op) ──────────────────
  if (fromAsset === toAsset) {
    logger.info("convertService: source already USDT — nothing to convert", {
      orderNo,
    });
    await markSkipped(orderNo, fromAsset, toAsset, fromAmount, "Source asset is already USDT").catch(() => {});
    return;
  }

  // ── Gate 3: Source coin must be in the enabled convert_assets list ─────────
  const inSourceList = await isSourceEnabled(fromAsset);
  if (!inSourceList) {
    logger.info("convertService: source coin not in enabled list — skipping", {
      orderNo, fromAsset,
    });
    await markSkipped(
      orderNo, fromAsset, toAsset, fromAmount,
      `Source asset ${fromAsset} is not enabled in the auto-convert list`
    ).catch(() => {});
    return;
  }

  // Persist the attempt BEFORE doing anything else — the UI will see PENDING
  // immediately and the row gets updated in place to SUCCESS/FAILED.
  let rowId;
  try {
    rowId = await insertPending(orderNo, fromAsset, toAsset, fromAmount);
  } catch (err) {
    logger.error("convertService: failed to insert PENDING row", {
      orderNo, error: err.message,
    });
    return;
  }

  logger.info("convertService: starting auto-convert", {
    orderNo, fromAsset, toAsset, fromAmount, rowId,
  });

  // Wait for the released crypto to actually appear in spot OR funding wallet.
  // P2P releases credit the FUNDING wallet by default on merchant accounts;
  // converting from FUNDING requires `walletType: 'FUNDING'` on the quote.
  const balance = await waitForBalance(fromAsset, fromAmount);
  logger.info("convertService: post-release balance check", {
    orderNo,
    fromAsset,
    advertised: fromAmount,
    spotFree:   balance.spot,
    fundingFree: balance.funding,
    chose:      balance.walletType || '(none)',
    available:  balance.available,
  });
  if (!balance.walletType) {
    const msg = `Released crypto did not appear in time. Spot=${balance.spot} Funding=${balance.funding} need≥${(fromAmount * FEE_TOLERANCE).toFixed(8)}`;
    logger.warn("convertService: balance never landed in time — marking FAILED", {
      orderNo, fromAsset, fromAmount,
      spotFree: balance.spot, fundingFree: balance.funding,
    });
    await markFailed(rowId, msg).catch(() => {});
    return;
  }
  const walletType = balance.walletType;

  // Use the ACTUAL settled balance for the conversion. Binance deducts a
  // small P2P fee on release, so wallet credit is always a touch less than
  // the order's advertised cryptoAmount. We convert what's truly available.
  const convertAmount = Number(balance.available) || 0;
  if (convertAmount <= 0) {
    const msg = `Detected wallet (${walletType}) but available amount was 0`;
    logger.warn("convertService: zero available after detect — FAILED", { orderNo, msg });
    await markFailed(rowId, msg).catch(() => {});
    return;
  }

  // Patch the PENDING row's from_amount to the real amount being converted
  // (might differ slightly from the advertised cryptoAmount due to fees).
  try {
    await pool.query(
      "UPDATE conversions SET from_amount = ? WHERE id = ?",
      [convertAmount, rowId]
    );
  } catch (_) { /* non-fatal — display will catch up on next poll */ }

  // SINGLE-ATTEMPT QUOTE + ACCEPT (using the wallet that actually has the funds
  // and the actual settled amount, not the advertised gross).
  let quote;
  try {
    quote = await getConvertQuote(fromAsset, toAsset, convertAmount, { walletType });
  } catch (err) {
    const msg = err.response?.data?.msg || err.message || "getQuote failed";
    logger.error("convertService: getQuote failed", {
      orderNo, walletType, convertAmount, error: msg,
    });
    await markFailed(rowId, `getQuote (${walletType}): ${msg}`).catch(() => {});
    return;
  }
  const quoteId = quote?.quoteId;
  const rate = Number(quote?.ratio) || null;
  const expectedToAmount = Number(quote?.toAmount) || null;

  if (!quoteId) {
    const msg = "getQuote returned no quoteId";
    logger.error("convertService: " + msg, { orderNo, quote });
    await markFailed(rowId, msg).catch(() => {});
    return;
  }

  let accepted;
  try {
    accepted = await acceptConvertQuote(quoteId);
  } catch (err) {
    const msg = err.response?.data?.msg || err.message || "acceptQuote failed";
    logger.error("convertService: acceptQuote failed", { orderNo, quoteId, error: msg });
    await markFailed(rowId, `acceptQuote: ${msg}`, { quoteId }).catch(() => {});
    return;
  }
  const orderId = accepted?.orderId || null;
  const initialStatus = String(accepted?.orderStatus || "").toUpperCase();

  // If Binance says PROCESS, query orderStatus to confirm final outcome
  let finalStatus = initialStatus;
  let finalToAmount = expectedToAmount;
  if (orderId && initialStatus !== "SUCCESS") {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await getConvertOrderStatus({ orderId });
      finalStatus = String(status?.orderStatus || finalStatus).toUpperCase();
      if (status?.toAmount) finalToAmount = Number(status.toAmount);
    } catch (err) {
      logger.warn("convertService: orderStatus check failed (assuming initial status)", {
        orderNo, orderId, error: err.message,
      });
    }
  }

  if (finalStatus === "SUCCESS") {
    await markSuccess(rowId, {
      toAmount: finalToAmount,
      rate,
      quoteId,
      orderId,
    }).catch(() => {});
    logger.info("convertService: conversion SUCCESS", {
      orderNo, fromAsset, toAsset,
      advertised: fromAmount,
      actual:     convertAmount,
      toAmount:   finalToAmount,
      rate, orderId, walletType,
    });
  } else {
    const msg = `Binance returned orderStatus=${finalStatus || "(unknown)"}`;
    logger.error("convertService: conversion not successful", {
      orderNo, fromAsset, toAsset, orderId, finalStatus,
    });
    await markFailed(rowId, msg, { quoteId, orderId }).catch(() => {});
  }
}

module.exports = { convertAfterRelease, FIXED_TARGET };
