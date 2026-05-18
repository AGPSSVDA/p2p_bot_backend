const { pool } = require("../config/mysql");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  orderDbService — DB-side mirror of in-memory order state
//
//  All writes are best-effort and never throw to the caller; a DB hiccup
//  must not break the order lifecycle in stateManager / orderHandler.
// ─────────────────────────────────────────────────────────────────────────────

function tsOrNull(v) {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

function safe(promise, label) {
  return Promise.resolve(promise).catch((err) => {
    logger.warn(`DB write failed: ${label}`, { error: err.message });
  });
}

// ── Upsert an order row when it's first detected ─────────────────────────────
async function upsertOrder(order) {
  const sql = `
    INSERT INTO orders (
      order_no, adv_no, trade_type, asset, fiat,
      amount, crypto_amount, seller_nickname, seller_user_id, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      adv_no = COALESCE(VALUES(adv_no), adv_no),
      asset = COALESCE(VALUES(asset), asset),
      fiat = COALESCE(VALUES(fiat), fiat),
      amount = COALESCE(VALUES(amount), amount),
      crypto_amount = COALESCE(VALUES(crypto_amount), crypto_amount),
      seller_nickname = COALESCE(VALUES(seller_nickname), seller_nickname),
      seller_user_id = COALESCE(VALUES(seller_user_id), seller_user_id),
      state = VALUES(state)
  `;
  return safe(
    pool.query(sql, [
      order.orderNo,
      order.advOrderNo || null,
      "BUY",
      order.asset || null,
      order.fiat || null,
      order.amount || 0,
      order.cryptoAmount || 0,
      order.sellerNickname || null,
      order.sellerUserId || null,
      order.state || "NEW_ORDER",
    ]),
    "upsertOrder"
  );
}

// ── Patch any subset of fields onto an existing order row ────────────────────
async function updateOrder(orderNo, fields) {
  if (!fields || !Object.keys(fields).length) return;
  const cols = Object.keys(fields);
  const vals = cols.map((k) => fields[k]);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  return safe(
    pool.query(`UPDATE orders SET ${setClause} WHERE order_no = ?`, [...vals, orderNo]),
    `updateOrder:${orderNo}`
  );
}

// ── Patch state + terminal timestamps ────────────────────────────────────────
async function setOrderState(orderNo, fromState, toState, extra = {}) {
  const fields = { state: toState };
  if (toState === "COMPLETED") fields.completed_at = new Date();
  if (toState === "CANCELLED") fields.cancelled_at = new Date();
  if (toState === "ESCALATED") fields.escalated_at = new Date();
  await updateOrder(orderNo, fields);
  await safe(
    pool.query(
      "INSERT INTO order_state_log (order_no, from_state, to_state, reason) VALUES (?, ?, ?, ?)",
      [orderNo, fromState || null, toState, extra.reason || null]
    ),
    `logState:${orderNo}`
  );
}

// ── Persist payment details once seller's pay info is known ──────────────────
async function setPaymentDetails(orderNo, payDetails) {
  if (!payDetails) return;
  await updateOrder(orderNo, {
    payment_method: payDetails.methodName || null,
    upi_id: payDetails.upiId || null,
    account_no: payDetails.accountNo || null,
    ifsc_code: payDetails.ifscCode || null,
    bank_name: payDetails.bankName || null,
    account_name: payDetails.accountName || null,
  });
}

// ── Persist KYC/seller-name + Binance deadlines from order detail prefetch ───
async function setOrderDetailFields(orderNo, fields) {
  const patch = {};
  if (fields.sellerName !== undefined) patch.seller_name = fields.sellerName || null;
  if (fields.sellerUserId !== undefined) patch.seller_user_id = fields.sellerUserId || null;
  if (fields.confirmPayEndTime !== undefined) patch.confirm_pay_end_time = tsOrNull(fields.confirmPayEndTime);
  if (fields.notifyPayEndTime !== undefined) patch.notify_pay_end_time = tsOrNull(fields.notifyPayEndTime);
  await updateOrder(orderNo, patch);
}

// ── Persist TDS breakdown ────────────────────────────────────────────────────
async function setTdsBreakdown(orderNo, pan, panName, tds) {
  await updateOrder(orderNo, {
    pan: pan || null,
    pan_name: panName || null,
    pre_tds_amount: tds?.preTDS ?? null,
    tds_amount: tds?.tds ?? null,
    post_tds_amount: tds?.postTDS ?? null,
  });
}

// ── Persist name-match result ────────────────────────────────────────────────
async function setNameMatch(orderNo, matched, compareSource) {
  await updateOrder(orderNo, {
    name_match_status: matched ? "MATCH" : "MISMATCH",
    name_match_compare_source: compareSource || null,
  });
}

// ── Bump pan_retries column to match in-memory counter ───────────────────────
async function setPanRetries(orderNo, retries) {
  await updateOrder(orderNo, { pan_retries: retries });
}

// ── Persist payout result + create a payouts row when payment is sent ────────
async function recordPayoutSuccess(order, payoutId, utr, mode) {
  await updateOrder(order.orderNo, {
    payout_id: payoutId || null,
    utr_number: utr || null,
  });

  // Mirror into payouts table for the TDS / Payments pages
  const sql = `
    INSERT INTO payouts (
      order_id, pan_name, seller_pan, total_order_amount,
      tds_amount, amount, utr_number, upi_id, payment_method, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      utr_number = VALUES(utr_number),
      status = VALUES(status)
  `;
  return safe(
    pool.query(sql, [
      order.orderNo,
      order.panName || order.paymentDetails?.accountName || null,
      order.pan || null,
      order.tds?.preTDS ?? order.amount ?? 0,
      order.tds?.tds ?? 0,
      order.tds?.postTDS ?? 0,
      utr || null,
      order.paymentDetails?.upiId || null,
      mode || order.paymentDetails?.methodName || null,
      "SUCCESS",
    ]),
    `recordPayout:${order.orderNo}`
  );
}

// ── Pending/manual payout row (e.g. Phase 1 manual payment) ──────────────────
async function recordPayoutPending(order) {
  const sql = `
    INSERT INTO payouts (
      order_id, pan_name, seller_pan, total_order_amount,
      tds_amount, amount, upi_id, payment_method, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    ON DUPLICATE KEY UPDATE status = 'PENDING'
  `;
  return safe(
    pool.query(sql, [
      order.orderNo,
      order.panName || order.paymentDetails?.accountName || null,
      order.pan || null,
      order.tds?.preTDS ?? order.amount ?? 0,
      order.tds?.tds ?? 0,
      order.tds?.postTDS ?? 0,
      order.paymentDetails?.upiId || null,
      order.paymentDetails?.methodName || null,
    ]),
    `recordPayoutPending:${order.orderNo}`
  );
}

// ── Upsert ad row (called from orderPoller when raw order has adv data) ──────
async function upsertAdFromOrder(rawOrder) {
  const advNo = rawOrder.adOrderNo || rawOrder.advNo || null;
  if (!advNo) return;
  const sql = `
    INSERT INTO ads (adv_no, trade_type, asset, fiat, last_seen_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      trade_type = COALESCE(VALUES(trade_type), trade_type),
      asset = COALESCE(VALUES(asset), asset),
      fiat = COALESCE(VALUES(fiat), fiat),
      last_seen_at = CURRENT_TIMESTAMP
  `;
  return safe(
    pool.query(sql, [
      advNo,
      "BUY",
      rawOrder.asset || null,
      rawOrder.fiat || null,
    ]),
    `upsertAd:${advNo}`
  );
}

// ── Upsert ad row from a Binance ads API result ──────────────────────────────
async function upsertAdFromBinance(ad) {
  if (!ad?.advNo && !ad?.advOrderNo) return;
  const advNo = ad.advNo || ad.advOrderNo;
  const sql = `
    INSERT INTO ads (
      adv_no, trade_type, asset, fiat, price,
      min_amount, max_amount, status, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      trade_type = VALUES(trade_type),
      asset = VALUES(asset),
      fiat = VALUES(fiat),
      price = VALUES(price),
      min_amount = VALUES(min_amount),
      max_amount = VALUES(max_amount),
      status = VALUES(status),
      last_synced_at = CURRENT_TIMESTAMP
  `;
  return safe(
    pool.query(sql, [
      advNo,
      ad.tradeType || ad.advType || null,
      ad.asset || null,
      ad.fiatUnit || ad.fiat || null,
      ad.price ?? null,
      ad.minSingleTransAmount ?? ad.minAmount ?? null,
      ad.maxSingleTransAmount ?? ad.maxAmount ?? null,
      ad.advStatus || ad.status || null,
    ]),
    `upsertAdBinance:${advNo}`
  );
}

// ── Log each chat message (in or out) for an order ───────────────────────────
async function logChatMessage({ orderNo, direction, sender, templateKey, text, sentStatus }) {
  return safe(
    pool.query(
      `INSERT INTO order_messages (order_no, direction, sender, template_key, message_text, sent_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderNo, direction, sender || null, templateKey || null, String(text || "").slice(0, 4000), sentStatus || null]
    ),
    `logChat:${orderNo}`
  );
}

module.exports = {
  upsertOrder,
  updateOrder,
  setOrderState,
  setPaymentDetails,
  setOrderDetailFields,
  setTdsBreakdown,
  setNameMatch,
  setPanRetries,
  recordPayoutSuccess,
  recordPayoutPending,
  upsertAdFromOrder,
  upsertAdFromBinance,
  logChatMessage,
};
