// Paywize webhook endpoint tester — simulates a Paywize callback POST to
// your backend's /api/paywize/webhook so you can verify:
//
//   1. The URL is reachable from the public internet (HTTPS, port 443, no
//      firewall in the way).
//   2. express.raw() is mounted BEFORE express.json() so signature checks
//      see the original bytes.
//   3. signature verification works end-to-end (HMAC-SHA256 of raw body
//      using PAYWIZE_SECRET_KEY).
//   4. Payload decrypt + status mapping work.
//   5. The bot's orderHandler.finalizePayoutSuccess actually drives the
//      chat-template + state transition (look in your bot logs for
//      "paywize webhook applied" and the state change).
//
// Usage:
//   # Pure URL-reachability check (no auth/sig — confirms route exists):
//   node scripts/paywizeWebhookTest.js
//
//   # Full signed + encrypted webhook for an order ALREADY in PENDING state:
//   node scripts/paywizeWebhookTest.js --order=<orderNo> --status=success --utr=999888777
//   node scripts/paywizeWebhookTest.js --order=<orderNo> --status=failed
//
// Notes:
//   • The script computes the same sender_id the bot uses (sha256 of "p2p|<orderNo>")
//     so the webhook matches the row written by paywize.js processPayment().
//   • --webhook-url can override the default (defaults to PAYWIZE_CALLBACK_URL
//     from .env, then falls back to local http://localhost:5000/api/paywize/webhook).

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
const status  = (args.status || "success").toUpperCase();   // SUCCESS / FAILED / PROCESSING
const utr     = args.utr || (status === "SUCCESS" ? `T${Date.now()}` : null);
const webhookUrl = args["webhook-url"]
                || process.env.PAYWIZE_CALLBACK_URL
                || `${(process.env.APP_PUBLIC_URL || "http://localhost:5000").replace(/\/$/, "")}/api/paywize/webhook`;
const secretKey = process.env.PAYWIZE_SECRET_KEY;
const walletId  = process.env.PAYWIZE_WALLET_ID;

if (!secretKey) {
  console.error("Missing PAYWIZE_SECRET_KEY in .env");
  process.exit(1);
}

// ── helpers (must match paywize.js exactly) ──────────────────────────────────
function encryptV2(data, sk) {
  if (typeof data === "object") data = JSON.stringify(data);
  const nonce  = crypto.randomBytes(12);
  const key    = crypto.createHash("sha256").update(sk).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct     = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

function senderIdFromOrderNo(orderNo) {
  const hash = crypto.createHash("sha256").update(`p2p|${orderNo}`).digest("hex").slice(0, 24);
  return `tx_${hash}`;
}

(async () => {
  console.log("\n=== Paywize webhook tester ===");
  console.log("target URL :", webhookUrl);
  console.log("order      :", orderNo || "(none — running URL reachability only)");
  console.log("status     :", status);
  console.log("utr        :", utr || "(none)");
  console.log();

  // ── Phase 1: URL reachability + middleware order check ────────────────────
  console.log("── Phase 1: URL reachability (POST with empty JSON) ──");
  try {
    const r0 = await axios.post(webhookUrl, { ping: true }, {
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
      timeout: 15000,
    });
    console.log("HTTP", r0.status, "→", typeof r0.data === "object" ? JSON.stringify(r0.data) : String(r0.data).slice(0, 200));
    if (r0.status === 404) {
      console.log("❌ Endpoint does not exist — check src/index.js mounts /api/paywize/webhook.");
      return;
    }
    if (r0.status >= 500) {
      console.log("⚠  5xx — the route is reachable but the handler crashed. Check bot logs.");
    }
    // Expected: 200 with { ok:false, reason: 'signature_invalid' } OR 'no_transfer_id'
    console.log("✓ URL is reachable");
  } catch (e) {
    console.log("❌ Network/DNS/TLS error:", e.message);
    console.log("   → check DNS, firewall, HTTPS cert, port 443 open externally.");
    return;
  }
  console.log();

  if (!orderNo) {
    console.log("(no --order given, skipping signed-webhook test)");
    console.log();
    console.log("To run a real test:");
    console.log("  node scripts/paywizeWebhookTest.js --order=<liveOrderNoInPendingState> --status=success --utr=999888777");
    return;
  }

  // ── Phase 2: signed + encrypted webhook for a real order ──────────────────
  const senderId = senderIdFromOrderNo(orderNo);
  console.log("── Phase 2: signed + encrypted webhook ──");
  console.log("derived sender_id (must match orders.payout_id):", senderId);
  console.log();

  const decryptedPayload = {
    transaction_id: `PWZ_T${Date.now()}`,
    sender_id:      senderId,
    wallet_id:      walletId || "PAYWIZE517725060",
    amount:         "100.00",
    payment_mode:   "IMPS",
    status:         status,                                                 // SUCCESS | FAILED | PROCESSING
    status_message: status === "FAILED" ? "Test failure (manual webhook)" : "OK",
    utr_number:     utr,
    beneficiary: {
      beneficiary_name:       "Test Seller",
      beneficiary_acc_number: "00000000000000",
      beneficiary_ifsc:       "HDFC0000001",
    },
    timestamps: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
  console.log("decrypted payload to be sent:", JSON.stringify(decryptedPayload, null, 2));

  // Encrypt the payload (Paywize's webhook body shape: { data: <encrypted base64> })
  const encryptedData = encryptV2(decryptedPayload, secretKey);
  const bodyObj = { data: encryptedData };
  const rawBody = JSON.stringify(bodyObj);

  // Compute signature (must match paywize.js verifyWebhookSignature)
  const sigHex = crypto.createHmac("sha256", secretKey).update(rawBody).digest("hex");
  const sigHeader = `sha256=${sigHex}`;
  console.log();
  console.log("encrypted blob length:", encryptedData.length);
  console.log("signature header     :", sigHeader.slice(0, 32) + "…");
  console.log();

  console.log("── POSTing signed webhook ──");
  try {
    const r = await axios.post(webhookUrl, rawBody, {
      headers: {
        "Content-Type":       "application/json",
        "X-Paywize-Signature": sigHeader,
        "User-Agent":          "PayWize-Webhook/1.0",
      },
      validateStatus: () => true,
      timeout: 20000,
    });
    console.log("HTTP", r.status);
    console.log("response body:", typeof r.data === "object" ? JSON.stringify(r.data) : String(r.data).slice(0, 400));
    console.log();
    if (r.status === 200 && r.data?.ok === true) {
      console.log("✅ Webhook accepted by the bot. orderNo =", r.data.orderNo, " newStatus =", r.data.status);
      console.log("   → Check the bot's logs for 'paywize webhook applied' + state transition.");
      console.log("   → If status=SUCCESS, the seller should now see the paymentSent template.");
      console.log("   → If status=FAILED, the bot will try to cancel the order on Binance.");
    } else if (r.data?.reason === "signature_invalid") {
      console.log("❌ Signature was rejected — check PAYWIZE_SECRET_KEY matches between this script and the bot.");
    } else if (r.data?.reason === "order_not_found") {
      console.log("❌ Order not found — the orders.payout_id for this orderNo doesn't equal", senderId);
      console.log("   → Was the order actually processed through Paywize (not Razorpay)?");
      console.log("   → Check: SELECT order_no, payout_id, state, utr_number FROM orders WHERE order_no=", JSON.stringify(orderNo));
    } else if (r.data?.reason === "no_transfer_id") {
      console.log("❌ Webhook decrypted but sender_id missing — likely encrypt/decrypt key mismatch.");
    } else {
      console.log("⚠  Unexpected response — inspect above.");
    }
  } catch (e) {
    console.log("❌ Network error sending webhook:", e.message);
  }

  console.log();
  console.log("── Verifying DB row was updated ──");
  console.log("Run on the DB host:");
  console.log(`   SELECT order_no, state, payout_id, utr_number, updated_at`);
  console.log(`     FROM orders WHERE order_no = ${JSON.stringify(orderNo)};`);
  console.log(`   SELECT order_id, status, utr_number FROM payouts WHERE order_id = ${JSON.stringify(orderNo)};`);
})();
