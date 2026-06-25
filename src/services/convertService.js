const { pool } = require("../config/mysql");
const botStatusService = require("./botStatusService");
const {
  getConvertQuote,
  acceptConvertQuote,
  getConvertOrderStatus,
  getSpotBalance,
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
const BALANCE_POLL_TIMEOUT_MS = 10_000;
const BALANCE_POLL_INTERVAL_MS = 1_500;

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

// Poll spot balance until at least `minAmount` of `asset` is free, or timeout.
async function waitForBalance(asset, minAmount, timeoutMs = BALANCE_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const bal = await getSpotBalance(asset);
      if (bal.free >= minAmount) return bal.free;
    } catch (err) {
      logger.warn("convertService: balance poll failed (will retry)", {
        asset, error: err.message,
      });
    }
    await new Promise((r) => setTimeout(r, BALANCE_POLL_INTERVAL_MS));
  }
  try {
    const bal = await getSpotBalance(asset);
    return bal.free;
  } catch (_) {
    return 0;
  }
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

  // ── Gate 1: Master switch (auto_convert_enabled) ───────────────────────────
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

  // Wait for the released crypto to actually appear in spot wallet
  const available = await waitForBalance(fromAsset, fromAmount);
  if (available < fromAmount) {
    const msg = `Spot balance after release was insufficient (have ${available}, need ${fromAmount})`;
    logger.warn("convertService: balance never landed in time — marking FAILED", {
      orderNo, fromAsset, fromAmount, available,
    });
    await markFailed(rowId, msg).catch(() => {});
    return;
  }

  // SINGLE-ATTEMPT QUOTE + ACCEPT
  let quote;
  try {
    quote = await getConvertQuote(fromAsset, toAsset, fromAmount);
  } catch (err) {
    const msg = err.response?.data?.msg || err.message || "getQuote failed";
    logger.error("convertService: getQuote failed", { orderNo, error: msg });
    await markFailed(rowId, `getQuote: ${msg}`).catch(() => {});
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
      orderNo, fromAsset, toAsset, fromAmount, toAmount: finalToAmount, rate, orderId,
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
