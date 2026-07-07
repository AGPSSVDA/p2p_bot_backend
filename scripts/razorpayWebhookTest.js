// RazorpayX webhook endpoint tester — simulates a Razorpay callback POST to
// your backend's /api/razorpay/webhook so you can verify:
//
//   1. The URL is publicly reachable (DNS, HTTPS, firewall).
//   2. express.raw() is mounted BEFORE express.json() so signature checks
//      see the original bytes.
//   3. Signature verification works end-to-end (HMAC-SHA256 of raw body
//      using RAZORPAY_WEBHOOK_SECRET).
//   4. The bot's orderHandler.finalizePayoutSuccess/Failed drives the
//      chat-template + state transition (look for "razorpay webhook applied"
//      + state change to PAYMENT_SENT).
//
// Usage:
//   # URL reachability only (no order, no auth):
//   node scripts/razorpayWebhookTest.js
//
//   # List real Razorpay-pending orders you can test against:
//   node scripts/razorpayWebhookTest.js --list-pending
//
//   # Inspect a specific order (DB row + deterministic id check):
//   node scripts/razorpayWebhookTest.js --inspect=<orderNo>
//
//   # Full signed webhook for an order in WAITING_FOR_RELEASE:
//   node scripts/razorpayWebhookTest.js --order=<orderNo> --status=processed --utr=999888
//   node scripts/razorpayWebhookTest.js --order=<orderNo> --status=failed
//
// Notes:
//   • Uses orders.payout_id directly (that's the RZP-issued `pout_...` id,
//     stored at initiate time by razorpay.js). Unlike Paywize, RZP's payout
//     id is what appears in webhook payloads too, so no hashing needed.
//   • --webhook-url overrides the default (falls back to APP_PUBLIC_URL).

require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto");

// ── arg parser ───────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const orderNo = args.order || null;
const status  = (args.status || "processed").toLowerCase();
const utr     = args.utr || (status === "processed" ? String(Math.floor(1e11 + Math.random() * 9e11)) : null);
const webhookUrl = args["webhook-url"]
                || `${(process.env.APP_PUBLIC_URL || "http://localhost:5000").replace(/\/$/, "")}/api/razorpay/webhook`;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

// ── Optional DB helpers ──────────────────────────────────────────────────────
async function withDb(fn) {
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST || "localhost",
    user:     process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "p2p",
    port:     process.env.DB_PORT || 3306,
  });
  try { return await fn(conn); } finally { await conn.end(); }
}

async function runListPending() {
  return withDb(async (conn) => {
    console.log("\n── Recent orders that may be Razorpay-pending ──");
    const [rows] = await conn.query(
      `SELECT order_no, state, payout_id, utr_number, updated_at
         FROM orders
        WHERE (state IN ('WAITING_FOR_RELEASE','PAYMENT_SENT')
               OR (utr_number IS NOT NULL AND utr_number LIKE 'PEND-%'))
          AND payout_id IS NOT NULL
          AND payout_id LIKE 'pout_%'
        ORDER BY updated_at DESC
        LIMIT 20`
    );
    if (rows.length === 0) {
      console.log("(no pending Razorpay orders found — look for orders with payout_id LIKE 'pout_%')");
    } else {
      console.log("Pick one of these order_no values for the --order arg:\n");
      console.table(rows.map(r => ({
        order_no:   r.order_no,
        state:      r.state,
        payout_id:  r.payout_id,
        utr:        r.utr_number,
        updated_at: r.updated_at,
      })));
    }
  });
}

async function runInspect(targetOrderNo) {
  return withDb(async (conn) => {
    console.log(`\n── Inspecting order ${targetOrderNo} ──`);
    const [rows] = await conn.query(
      `SELECT order_no, state, payout_id, utr_number, cancel_reason, processed_by, updated_at
         FROM orders WHERE order_no = ?`,
      [targetOrderNo]
    );
    if (rows.length === 0) {
      console.log("❌ order not found in DB.");
      return;
    }
    console.log(rows[0]);
    if (rows[0].payout_id?.startsWith("pout_")) {
      console.log("✓ payout_id looks like a Razorpay id — webhook can find this order.");
    } else if (rows[0].payout_id?.startsWith("tx_")) {
      console.log("ℹ payout_id starts with 'tx_' — this order was processed via Paywize, not Razorpay.");
    } else if (!rows[0].payout_id) {
      console.log("✗ payout_id is NULL — the bot never reached the payout stage (likely manual fallback).");
    } else {
      console.log("? Unknown payout_id shape.");
    }
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (args["list-pending"]) {
    try { await runListPending(); }
    catch (e) { console.error("DB error:", e.message); process.exit(2); }
    return;
  }
  if (args.inspect) {
    try { await runInspect(args.inspect); }
    catch (e) { console.error("DB error:", e.message); process.exit(2); }
    return;
  }

  console.log("\n=== RazorpayX webhook tester ===");
  console.log("target URL      :", webhookUrl);
  console.log("order           :", orderNo || "(none — URL reachability only)");
  console.log("status          :", status);
  console.log("utr             :", utr || "(none)");
  console.log("webhookSecret   :", webhookSecret ? "(set)" : "(MISSING — set RAZORPAY_WEBHOOK_SECRET in .env)");
  console.log();

  // ── Phase 1: URL reachability ────────────────────────────────────────────
  console.log("── Phase 1: URL reachability (POST with unsigned empty JSON) ──");
  try {
    const r0 = await axios.post(webhookUrl, { ping: true }, {
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
      timeout: 15000,
    });
    console.log("HTTP", r0.status, "→", typeof r0.data === "object" ? JSON.stringify(r0.data) : String(r0.data).slice(0, 200));
    if (r0.status === 404) {
      console.log("❌ Endpoint does not exist — check src/index.js mounts /api/razorpay/webhook.");
      return;
    }
    console.log("✓ URL reachable");
  } catch (e) {
    console.log("❌ Network/DNS/TLS error:", e.message);
    return;
  }
  console.log();

  if (!orderNo) {
    console.log("(no --order given, skipping signed-webhook test)");
    console.log();
    console.log("To run a real signed test, first find a pending order:");
    console.log("  node scripts/razorpayWebhookTest.js --list-pending");
    console.log("Then simulate a webhook against one of them:");
    console.log("  node scripts/razorpayWebhookTest.js --order=<orderNo> --status=processed --utr=999888");
    return;
  }

  if (!webhookSecret) {
    console.log("❌ Cannot sign — RAZORPAY_WEBHOOK_SECRET missing from .env.");
    return;
  }

  // ── Phase 2: fetch the DB row to get the real payout_id (pout_...) ───────
  let payoutId;
  try {
    payoutId = await withDb(async (conn) => {
      const [rows] = await conn.query(`SELECT payout_id FROM orders WHERE order_no = ?`, [orderNo]);
      return rows[0]?.payout_id || null;
    });
  } catch (e) {
    console.log("❌ DB lookup failed:", e.message);
    return;
  }
  if (!payoutId?.startsWith("pout_")) {
    console.log(`❌ Order ${orderNo} has no Razorpay payout_id (got: ${payoutId || "NULL"}).`);
    console.log("   Was this order processed via Razorpay? If Paywize, use paywizeWebhookTest.js.");
    return;
  }
  console.log("── Phase 2: signed + real webhook payload ──");
  console.log("payout_id from DB:", payoutId);

  // ── Build the payload in RazorpayX's real webhook shape ───────────────────
  const eventNameMap = {
    processed: "payout.processed",
    failed:    "payout.failed",
    reversed:  "payout.reversed",
    rejected:  "payout.rejected",
    initiated: "payout.initiated",
    queued:    "payout.queued",
    pending:   "payout.pending",
  };
  const eventName = eventNameMap[status] || `payout.${status}`;

  const payoutEntity = {
    id:              payoutId,
    entity:          "payout",
    fund_account_id: "fa_TEST",
    amount:          10000, // 100 INR in paise
    currency:        "INR",
    fees:            0,
    tax:             0,
    status:          status,
    utr:             utr,
    mode:            "IMPS",
    purpose:         "payout",
    reference_id:    `tx_test_${orderNo}`.slice(0, 32),
    narration:       "Test webhook",
    batch_id:        null,
    failure_reason:  status === "failed" ? "Test failure (manual webhook)" : null,
    status_details:  status === "failed"
                      ? { reason: "test_reason", description: "Test failure via manual webhook", source: "test" }
                      : null,
    created_at:      Math.floor(Date.now() / 1000),
  };

  const body = {
    entity:      "event",
    account_id:  "acc_TEST",
    event:       eventName,
    contains:    ["payout"],
    payload:     { payout: { entity: payoutEntity } },
    created_at:  Math.floor(Date.now() / 1000),
  };
  const rawBody = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  console.log("body length:", rawBody.length);
  console.log("event      :", eventName);
  console.log("signature  :", sig.slice(0, 24) + "…");
  console.log();

  console.log("── POSTing signed webhook ──");
  try {
    const r = await axios.post(webhookUrl, rawBody, {
      headers: {
        "Content-Type":         "application/json",
        "X-Razorpay-Signature": sig,
        "User-Agent":           "Razorpay-Webhook/1.0",
      },
      validateStatus: () => true,
      timeout: 20000,
    });
    console.log("HTTP", r.status);
    console.log("response body:", typeof r.data === "object" ? JSON.stringify(r.data) : String(r.data).slice(0, 400));
    console.log();
    if (r.status === 200 && r.data?.ok === true) {
      console.log("✅ Webhook accepted. orderNo =", r.data.orderNo, " newStatus =", r.data.status);
      console.log("   → Check bot logs for 'razorpay webhook applied' + chat template send.");
    } else if (r.data?.reason === "signature_invalid") {
      console.log("❌ Signature was rejected — RAZORPAY_WEBHOOK_SECRET here differs from what the bot uses.");
    } else if (r.data?.reason === "order_not_found") {
      console.log("❌ Order not found — the orders.payout_id for this orderNo doesn't equal", payoutId);
    } else {
      console.log("⚠  Unexpected response — inspect above.");
    }
  } catch (e) {
    console.log("❌ Network error:", e.message);
  }
})();
