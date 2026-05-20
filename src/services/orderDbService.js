const { pool } = require("../config/mysql");
const { config } = require("../config/config");
const logger = require("../utils/logger");

// Bot-configured TDS percentage (default 1%). Used to backfill TDS amounts
// on synced COMPLETED orders that never went through the live PAN/TDS flow.
const TDS_PCT = Number(config?.bot?.tdsPercent) || 1;

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
//   This is the BOT-driven path: stamps processed_by='BOT' on new rows AND
//   on existing rows (e.g. a previously-synced MANUAL row gets promoted to
//   BOT once the live flow starts handling it).
async function upsertOrder(order) {
  const sql = `
    INSERT INTO orders (
      order_no, adv_no, trade_type, asset, fiat,
      amount, crypto_amount, seller_nickname, seller_user_id, state, processed_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOT')
    ON DUPLICATE KEY UPDATE
      adv_no = COALESCE(VALUES(adv_no), adv_no),
      asset = COALESCE(VALUES(asset), asset),
      fiat = COALESCE(VALUES(fiat), fiat),
      amount = COALESCE(VALUES(amount), amount),
      crypto_amount = COALESCE(VALUES(crypto_amount), crypto_amount),
      seller_nickname = COALESCE(VALUES(seller_nickname), seller_nickname),
      seller_user_id = COALESCE(VALUES(seller_user_id), seller_user_id),
      state = VALUES(state),
      processed_by = 'BOT'
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

// ── Upsert into the canonical verified_sellers ledger ──────────────────────
// Called whenever the bot successfully verifies a PAN AND name match passes.
// The unique key is `pan` — one row per PAN, accumulating each new payment
// method / nickname over time. COALESCE keeps existing non-null values
// (we don't want a later order's NULL to clobber the original capture).
async function upsertVerifiedSeller(data) {
  if (!data || !data.pan) return;
  const sql = `
    INSERT INTO verified_sellers (
      pan, pan_name, seller_user_id, seller_nickname, seller_name,
      account_no, upi_id, ifsc_code, bank_name, account_name,
      first_order_no, last_order_no, verification_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      pan_name        = COALESCE(VALUES(pan_name),        pan_name),
      seller_user_id  = COALESCE(VALUES(seller_user_id),  seller_user_id),
      seller_nickname = COALESCE(VALUES(seller_nickname), seller_nickname),
      seller_name     = COALESCE(VALUES(seller_name),     seller_name),
      account_no      = COALESCE(VALUES(account_no),      account_no),
      upi_id          = COALESCE(VALUES(upi_id),          upi_id),
      ifsc_code       = COALESCE(VALUES(ifsc_code),       ifsc_code),
      bank_name       = COALESCE(VALUES(bank_name),       bank_name),
      account_name    = COALESCE(VALUES(account_name),    account_name),
      last_order_no   = VALUES(last_order_no),
      verification_count = verification_count + 1
  `;
  return safe(
    pool.query(sql, [
      String(data.pan),
      data.panName || null,
      data.sellerUserId || null,
      data.sellerNickname || null,
      data.sellerName || null,
      data.accountNo || null,
      data.upiId || null,
      data.ifscCode || null,
      data.bankName || null,
      data.accountName || null,
      data.orderNo || null,    // first_order_no — only used on INSERT
      data.orderNo || null,    // last_order_no  — overwritten on UPDATE
    ]),
    `upsertVerifiedSeller:${String(data.pan).slice(0, 3)}XX`
  );
}

// ── Find a verified seller from the verified_sellers ledger ────────────────
// Reads from the canonical verified_sellers table (not the orders table),
// so the lookup is independent of whether any individual prior order
// reached COMPLETED. Once a PAN is verified for a seller, that ledger row
// persists permanently — every future order from the same identity can
// look it up.
//
// IDENTITY MATCHING — SAFETY FIRST + RESILIENT TO METHOD CHANGES
// We never trust a single soft signal. Any one of the following identity
// proofs is acceptable; everything else falls through to the first-time
// PAN flow (the safe default):
//
//   A. seller_user_id   — Binance internal account ID (when Binance
//                          returns it). One human ↔ one ID. Highest trust.
//   B. nickname + name  — Binance nickname is unique at any moment, and
//                          the KYC name cross-check blocks the rare
//                          nickname-recycled-by-a-stranger case. Survives
//                          payment-method changes.
//   C. name + account_no — Bank account is KYC'd to a single PAN at the
//                          bank; composite cannot collide between people.
//   D. name + upi_id    — Same logic as (C).
//
// EXPLICITLY REJECTED:
//   - name-only match        — two strangers can share a KYC name
//   - nickname-only match    — a recycled nickname would leak a stranger's
//                              previously-verified PAN
//
// Returns the matched verified_sellers row (with a `matched_on` field
// indicating which branch fired), or null if no prior verification.
async function findVerifiedSellerHistory({
  sellerUserId,
  sellerNickname,
  sellerName,
  accountNo,
  upiId,
} = {}) {
  const uid      = sellerUserId   ? String(sellerUserId).trim()   : "";
  const nick     = sellerNickname ? String(sellerNickname).trim() : "";
  const name     = sellerName     ? String(sellerName).trim()     : "";
  const account  = accountNo      ? String(accountNo).trim()      : "";
  const upi      = upiId          ? String(upiId).trim()          : "";

  const canMatchByUid      = !!uid;
  const canMatchByNick     = !!nick && !!name;
  const canMatchByAccount  = !!name && !!account;
  const canMatchByUpi      = !!name && !!upi;
  if (!canMatchByUid && !canMatchByNick && !canMatchByAccount && !canMatchByUpi) {
    return null;
  }

  const columns = `id, pan, pan_name, seller_user_id, seller_nickname,
                   seller_name, account_no, upi_id, ifsc_code,
                   bank_name, account_name, last_order_no,
                   verification_count, first_verified_at, last_verified_at`;
  const orderClause = `ORDER BY last_verified_at DESC, id DESC LIMIT 1`;

  try {
    // 1. PRIMARY: Binance counterPartUserId.
    if (canMatchByUid) {
      const [rows] = await pool.query(
        `SELECT ${columns} FROM verified_sellers
          WHERE seller_user_id = ?
          ${orderClause}`,
        [uid]
      );
      if (rows[0]) {
        return {
          ...rows[0],
          order_no: rows[0].last_order_no,   // back-compat field name
          matched_on: "seller_user_id",
        };
      }
    }

    // 2. COMPOSITE: Binance nickname + KYC name (case-insensitive).
    if (canMatchByNick) {
      const [rows] = await pool.query(
        `SELECT ${columns} FROM verified_sellers
          WHERE LOWER(TRIM(seller_nickname)) = LOWER(TRIM(?))
            AND LOWER(TRIM(seller_name))     = LOWER(TRIM(?))
          ${orderClause}`,
        [nick, name]
      );
      if (rows[0]) {
        return {
          ...rows[0],
          order_no: rows[0].last_order_no,
          matched_on: "nickname+name",
        };
      }
    }

    // 3. COMPOSITE: name + bank account number.
    if (canMatchByAccount) {
      const [rows] = await pool.query(
        `SELECT ${columns} FROM verified_sellers
          WHERE LOWER(TRIM(seller_name)) = LOWER(TRIM(?))
            AND TRIM(account_no)         = TRIM(?)
          ${orderClause}`,
        [name, account]
      );
      if (rows[0]) {
        return {
          ...rows[0],
          order_no: rows[0].last_order_no,
          matched_on: "name+account_no",
        };
      }
    }

    // 4. COMPOSITE: name + UPI id (both case-insensitive).
    if (canMatchByUpi) {
      const [rows] = await pool.query(
        `SELECT ${columns} FROM verified_sellers
          WHERE LOWER(TRIM(seller_name)) = LOWER(TRIM(?))
            AND LOWER(TRIM(upi_id))      = LOWER(TRIM(?))
          ${orderClause}`,
        [name, upi]
      );
      if (rows[0]) {
        return {
          ...rows[0],
          order_no: rows[0].last_order_no,
          matched_on: "name+upi_id",
        };
      }
    }

    return null;
  } catch (err) {
    logger.warn("findVerifiedSellerHistory failed", {
      sellerUserId: uid,
      sellerNickname: nick,
      sellerName: name,
      accountNo: account ? "present" : "(none)",
      upiId: upi ? "present" : "(none)",
      error: err.message,
    });
    return null;
  }
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

// ── Binance status → bot state mapping (for sync) ────────────────────────────
const BINANCE_STATUS_TO_STATE = {
  1: "WAITING_FOR_PAN",       // wait for payment
  2: "WAITING_FOR_RELEASE",   // wait for release (bot paid)
  3: "ESCALATED",             // appealing
  4: "COMPLETED",
  6: "CANCELLED",             // cancelled by user
  7: "CANCELLED",             // cancelled by system
};
const TERMINAL_STATES = new Set(["COMPLETED", "CANCELLED", "ESCALATED", "FAILED"]);

// ── Upsert a raw Binance order row directly into MySQL ───────────────────────
// Used by the periodic sync + the /api/admin/sync-binance-orders endpoint
// to backfill orders the bot's live poller never saw (e.g. orders already
// past status 1 when the bot booted, or terminal orders the bot missed).
//
// State precedence rules:
//   - If incoming is terminal (COMPLETED / CANCELLED / ESCALATED) →
//     force the row's state to the terminal one and set the matching
//     timestamp column.
//   - If incoming is in-flight (1, 2) →
//     INSERT IGNORE: never overwrite an existing in-memory bot state.
async function upsertOrderFromBinance(raw) {
  const orderNo = raw.orderNumber || raw.adOrderNo || raw.orderNo;
  if (!orderNo) return { skipped: true };

  const statusCode = Number(raw.orderStatus);
  const targetState = BINANCE_STATUS_TO_STATE[statusCode] || "NEW_ORDER";
  const isTerminal = TERMINAL_STATES.has(targetState);

  const finishMs = Number(raw.finishTime) || Number(raw.updateTime) || null;
  const completedAt = statusCode === 4 ? tsOrNull(finishMs || Date.now()) : null;
  const cancelledAt = statusCode === 6 || statusCode === 7
    ? tsOrNull(finishMs || Date.now()) : null;
  const escalatedAt = statusCode === 3 ? tsOrNull(finishMs || Date.now()) : null;

  const confirmPayEnd = tsOrNull(raw.confirmPayEndTime);
  const notifyPayEnd = tsOrNull(raw.notifyPayEndTime);

  // For COMPLETED orders, pre-compute TDS so it persists in the orders row.
  // For bot-handled orders the COALESCE clauses below will preserve the
  // existing (more accurate) values; for sync-only rows this fills them in.
  const orderAmount = Number(raw.totalPrice || raw.amount || 0);
  const isCompleted = statusCode === 4;
  const preTds  = isCompleted ? +orderAmount.toFixed(2) : null;
  const tdsAmt  = isCompleted ? +(orderAmount * (TDS_PCT / 100)).toFixed(2) : null;
  const postTds = isCompleted ? +(orderAmount - (tdsAmt || 0)).toFixed(2) : null;

  if (isTerminal) {
    // Force terminal state on existing rows; insert new ones with all metadata.
    // processed_by: new rows from sync get 'MANUAL'; existing BOT rows keep
    // their 'BOT' marker (the bot is still credited with handling it).
    const sql = `
      INSERT INTO orders (
        order_no, adv_no, trade_type, asset, fiat,
        amount, crypto_amount, seller_nickname, seller_user_id,
        state, completed_at, cancelled_at, escalated_at,
        confirm_pay_end_time, notify_pay_end_time,
        pre_tds_amount, tds_amount, post_tds_amount,
        processed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL')
      ON DUPLICATE KEY UPDATE
        adv_no = COALESCE(VALUES(adv_no), adv_no),
        asset = COALESCE(VALUES(asset), asset),
        fiat = COALESCE(VALUES(fiat), fiat),
        amount = COALESCE(VALUES(amount), amount),
        crypto_amount = COALESCE(VALUES(crypto_amount), crypto_amount),
        seller_nickname = COALESCE(VALUES(seller_nickname), seller_nickname),
        seller_user_id = COALESCE(VALUES(seller_user_id), seller_user_id),
        state = VALUES(state),
        completed_at = COALESCE(VALUES(completed_at), completed_at),
        cancelled_at = COALESCE(VALUES(cancelled_at), cancelled_at),
        escalated_at = COALESCE(VALUES(escalated_at), escalated_at),
        confirm_pay_end_time = COALESCE(VALUES(confirm_pay_end_time), confirm_pay_end_time),
        notify_pay_end_time = COALESCE(VALUES(notify_pay_end_time), notify_pay_end_time),
        pre_tds_amount = COALESCE(pre_tds_amount, VALUES(pre_tds_amount)),
        tds_amount = COALESCE(tds_amount, VALUES(tds_amount)),
        post_tds_amount = COALESCE(post_tds_amount, VALUES(post_tds_amount)),
        processed_by = processed_by
    `;
    await safe(
      pool.query(sql, [
        orderNo,
        raw.adOrderNo || raw.advNo || null,
        "BUY",
        raw.asset || null,
        raw.fiat || null,
        orderAmount,
        raw.amount || raw.cryptoAmount || 0,
        raw.counterPartNickName || raw.sellerNickname || null,
        raw.counterPartUserId || raw.sellerUserId || null,
        targetState,
        completedAt,
        cancelledAt,
        escalatedAt,
        confirmPayEnd,
        notifyPayEnd,
        preTds,
        tdsAmt,
        postTds,
      ]),
      `upsertFromBinance(terminal):${orderNo}`
    );

    // Also mirror to the `payouts` table so the Payments page picks up
    // historical completed orders too. Use INSERT IGNORE so we don't clobber
    // rows the bot's live payment flow has already recorded.
    if (isCompleted) {
      await safe(
        pool.query(
          `INSERT IGNORE INTO payouts (
             order_id, pan_name, seller_pan,
             total_order_amount, tds_amount, amount,
             payment_method, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SUCCESS', ?)`,
          [
            orderNo,
            raw.counterPartNickName || raw.sellerNickname || null,
            null,
            preTds,
            tdsAmt,
            postTds,
            null,
            completedAt || new Date(),
          ]
        ),
        `payoutMirror:${orderNo}`
      );
    }
  } else {
    // In-flight (status 1 or 2). Insert if missing, never clobber existing.
    // Mark new rows as MANUAL — if the bot later picks it up, upsertOrder()
    // will promote processed_by back to 'BOT'.
    const sql = `
      INSERT IGNORE INTO orders (
        order_no, adv_no, trade_type, asset, fiat,
        amount, crypto_amount, seller_nickname, seller_user_id,
        state, confirm_pay_end_time, notify_pay_end_time, processed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL')
    `;
    await safe(
      pool.query(sql, [
        orderNo,
        raw.adOrderNo || raw.advNo || null,
        "BUY",
        raw.asset || null,
        raw.fiat || null,
        raw.totalPrice || raw.amount || 0,
        raw.amount || raw.cryptoAmount || 0,
        raw.counterPartNickName || raw.sellerNickname || null,
        raw.counterPartUserId || raw.sellerUserId || null,
        targetState,
        confirmPayEnd,
        notifyPayEnd,
      ]),
      `upsertFromBinance(active):${orderNo}`
    );
  }

  // Also upsert the ad row so the Ads page picks it up
  await upsertAdFromOrder(raw);

  return { orderNo, statusCode, targetState, isTerminal };
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
  upsertOrderFromBinance,
  upsertVerifiedSeller,
  findVerifiedSellerHistory,
  logChatMessage,
  BINANCE_STATUS_TO_STATE,
};
