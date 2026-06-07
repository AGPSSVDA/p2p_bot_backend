#!/usr/bin/env node
/**
 * Diagnose why Surepass was / wasn't called for a specific order.
 *
 *   Prints:
 *     • Order row from `orders`
 *     • Whether the seller is in `verified_sellers` (returning vs first-time)
 *     • Bank-info compare (current order vs verified_sellers ledger)
 *     • Current Cashfree Bank Verify toggle status
 *     • Predicted code path (which branch the bot took)
 *
 *   Usage:
 *     node scripts/diagnoseOrderFlow.js <orderNo>
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const orderNo = process.argv[2];
if (!orderNo) {
  console.error("Usage: node scripts/diagnoseOrderFlow.js <orderNo>");
  process.exit(1);
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    connectionLimit: 2,
  });

  console.log("═════════════════════════════════════════════════════════════════");
  console.log("Diagnosing order:", orderNo);
  console.log("═════════════════════════════════════════════════════════════════");

  // ── 1. Order row ──────────────────────────────────────────────────────
  const [orderRows] = await pool.query(
    `SELECT order_no, state, processed_by, seller_nickname, seller_user_id,
            seller_name, pan, pan_name, name_match_status, name_match_compare_source,
            account_no, ifsc_code, account_name, bank_name, upi_id,
            payment_method, payout_id, utr_number, created_at, updated_at
       FROM orders WHERE order_no = ? OR order_id = ? LIMIT 1`,
    [orderNo, orderNo]
  );
  const order = orderRows[0];
  if (!order) {
    console.log("✗ Order not found in DB. The order poller may not have picked it up yet.");
    await pool.end();
    return;
  }

  console.log("\n[1] ORDER STATE");
  console.log("    state                     :", order.state);
  console.log("    processed_by              :", order.processed_by);
  console.log("    name_match_status         :", order.name_match_status || "(not set)");
  console.log("    name_match_compare_source :", order.name_match_compare_source || "(not set)");
  console.log("    seller_nickname           :", order.seller_nickname || "(none)");
  console.log("    seller_user_id            :", order.seller_user_id  || "(none)");
  console.log("    seller_name (KYC)         :", order.seller_name     || "(none)");
  console.log("    PAN                       :", order.pan ? `${order.pan.slice(0,3)}XX…X` : "(not captured yet)");
  console.log("    pan_name                  :", order.pan_name || "(not captured yet)");
  console.log("    current bank account_no   :", order.account_no ? `${order.account_no.slice(0,4)}…${order.account_no.slice(-4)}` : "(none)");
  console.log("    current bank ifsc         :", order.ifsc_code || "(none)");
  console.log("    current bank account_name :", order.account_name || "(none)");
  console.log("    upi_id                    :", order.upi_id || "(none)");

  // ── 2. Look up seller in verified_sellers (any matching identity) ────
  const [vsRows] = await pool.query(
    `SELECT id, pan, pan_name, seller_user_id, seller_nickname, seller_name,
            account_no, ifsc_code, account_name, bank_name, upi_id,
            last_order_no, verification_count, last_verified_at
       FROM verified_sellers
      WHERE (seller_user_id = ? AND seller_user_id IS NOT NULL)
         OR (seller_nickname = ? AND seller_name = ?)
         OR (seller_name = ? AND account_no = ?)
         OR (seller_name = ? AND upi_id = ?)
      ORDER BY last_verified_at DESC LIMIT 3`,
    [
      order.seller_user_id,
      order.seller_nickname, order.seller_name,
      order.seller_name, order.account_no,
      order.seller_name, order.upi_id,
    ]
  );

  console.log("\n[2] VERIFIED_SELLERS ledger lookup");
  if (vsRows.length === 0) {
    console.log("    ✗ NO match — this is a FIRST-TIME seller. Full PAN+bank flow should run via _handlePANReply.");
  } else {
    console.log(`    ✓ Found ${vsRows.length} matching ledger row(s) — RETURNING seller.`);
    vsRows.forEach((v, i) => {
      console.log(`    [match ${i + 1}]`);
      console.log("       id                 :", v.id);
      console.log("       pan                :", v.pan ? `${v.pan.slice(0,3)}XX…X` : "(none)");
      console.log("       pan_name           :", v.pan_name || "(none)");
      console.log("       seller_user_id     :", v.seller_user_id || "(none)");
      console.log("       seller_nickname    :", v.seller_nickname || "(none)");
      console.log("       seller_name        :", v.seller_name || "(none)");
      console.log("       account_no (prior) :", v.account_no ? `${v.account_no.slice(0,4)}…${v.account_no.slice(-4)}` : "(none)");
      console.log("       ifsc_code (prior)  :", v.ifsc_code || "(none)");
      console.log("       last_order_no      :", v.last_order_no);
      console.log("       verification_count :", v.verification_count);
      console.log("       last_verified_at   :", v.last_verified_at);
    });
  }

  // ── 3. Cashfree Bank Verify toggle ────────────────────────────────────
  const [cfgRows] = await pool.query(
    `SELECT cashfree_bank_verify_enabled, auto_payout, bot_status FROM bot_config ORDER BY id ASC LIMIT 1`
  );
  const cfg = cfgRows[0] || {};
  console.log("\n[3] BOT CONFIG (dashboard toggles)");
  console.log("    bot_status                    :", cfg.bot_status, cfg.bot_status === 1 ? "(ON)" : "(OFF)");
  console.log("    auto_payout                   :", cfg.auto_payout, cfg.auto_payout === 1 ? "(ON)" : "(OFF)");
  console.log("    cashfree_bank_verify_enabled  :", cfg.cashfree_bank_verify_enabled, cfg.cashfree_bank_verify_enabled === 1 ? "(ON)" : "(OFF — Surepass bank verify SKIPPED)");

  // ── 4. Bank-info compare (Option B fast path vs re-verify) ────────────
  console.log("\n[4] OPTION B BANK-INFO COMPARE (returning seller only)");
  if (vsRows.length === 0) {
    console.log("    n/a — first-time seller, Option B doesn't apply");
  } else {
    const h = vsRows[0];
    const currAcc = String(order.account_no || "").trim();
    const currIfsc = String(order.ifsc_code || "").trim().toUpperCase();
    const histAcc = String(h.account_no || "").trim();
    const histIfsc = String(h.ifsc_code || "").trim().toUpperCase();
    const hasCurrentBank = !!(currAcc && currIfsc);
    const changed = currAcc !== histAcc || currIfsc !== histIfsc;

    console.log("    hasCurrentBank   :", hasCurrentBank);
    console.log("    current account  :", currAcc ? `${currAcc.slice(0,4)}…${currAcc.slice(-4)}` : "(none)");
    console.log("    history account  :", histAcc ? `${histAcc.slice(0,4)}…${histAcc.slice(-4)}` : "(none)");
    console.log("    current ifsc     :", currIfsc || "(none)");
    console.log("    history ifsc     :", histIfsc || "(none)");
    console.log("    bankInfoChanged  :", changed);

    console.log("\n[5] PREDICTED CODE PATH");
    if (cfg.cashfree_bank_verify_enabled !== 1) {
      console.log("    → Toggle OFF → Surepass SKIPPED → fast skip directly to TDS template + payment");
    } else if (!hasCurrentBank) {
      console.log("    → No bank info (UPI only) → Surepass SKIPPED → goes to payment as UPI (manual fallback)");
    } else if (!changed) {
      console.log("    → Bank same as previous order → Surepass SKIPPED (Option B fast path) → goes to TDS template + payment");
      console.log("       This is INTENTIONAL — bank was already verified on a prior order.");
    } else {
      console.log("    → Bank CHANGED + toggle ON → Surepass SHOULD have been called");
      console.log("       Check bot logs for: 'Returning seller — bank info CHANGED ... re-verifying via Surepass'");
    }
  }

  console.log("\n═════════════════════════════════════════════════════════════════");
  await pool.end();
})().catch(e => { console.error("Error:", e.message); process.exit(1); });
