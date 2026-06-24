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
//  Flow (single attempt, no retry — per user requirement):
//    1. Skip if auto_convert_enabled = 0 in bot_config.
//    2. Skip if order asset already equals the target asset.
//    3. Insert a PENDING row into `conversions` immediately (so the UI shows
//       the attempt even if it later fails).
//    4. Poll the spot wallet for up to ~10s to confirm the released crypto
//       has actually landed (Binance can lag 1-5s after status=COMPLETED).
//    5. Request a quote, accept it, verify orderStatus.
//    6. Update the conversions row with SUCCESS + to_amount/rate/ref ids
//       OR FAILED + error_message.
//
//  Chat messages: NONE. This module is completely silent to the seller.
// ─────────────────────────────────────────────────────────────────────────────

const BALANCE_POLL_TIMEOUT_MS = 10_000;
const BALANCE_POLL_INTERVAL_MS = 1_500;

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
  // Last-ditch read so the caller sees what we ended with
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

  if (!orderNo || !fromAsset || !(fromAmount > 0)) {
    logger.debug("convertService: nothing to convert (missing fields)", {
      orderNo, fromAsset, fromAmount,
    });
    return;
  }

  // Read current config
  let enabled = false;
  let toAsset = "USDT";
  try {
    enabled = await botStatusService.isAutoConvertEnabled();
    toAsset = (await botStatusService.getConvertTargetAsset()) || "USDT";
  } catch (err) {
    logger.warn("convertService: failed to read bot_config — skipping convert", {
      orderNo, error: err.message,
    });
    return;
  }

  if (!enabled) {
    logger.info("convertService: auto-convert disabled — skipping", { orderNo });
    return;
  }

  toAsset = String(toAsset).toUpperCase();
  if (fromAsset === toAsset) {
    logger.info("convertService: source == target — nothing to convert", {
      orderNo, asset: fromAsset,
    });
    await markSkipped(orderNo, fromAsset, toAsset, fromAmount, "Source asset equals target asset").catch(() => {});
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
      // brief delay before status check
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

module.exports = { convertAfterRelease };
