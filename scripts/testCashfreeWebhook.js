#!/usr/bin/env node
/**
 * Manually fire a Cashfree-style webhook at the bot — exactly the way
 * Cashfree V2 would (signature = HMAC-SHA256(timestamp + body, clientSecret)).
 *
 * Usage:
 *   node scripts/testCashfreeWebhook.js <transfer_id> [SUCCESS|FAILED] [utr]
 *
 * Examples:
 *   # Successful settlement
 *   node scripts/testCashfreeWebhook.js tx_799671fd5f37bc0e9bc21ff5 SUCCESS IDFBH26156305968
 *
 *   # Failure
 *   node scripts/testCashfreeWebhook.js tx_799671fd5f37bc0e9bc21ff5 FAILED
 *
 *   # Override the webhook URL (defaults to local bot via .env API_PORT)
 *   WEBHOOK_URL=https://api.agpssvda.com/api/cashfree/webhook \
 *     node scripts/testCashfreeWebhook.js tx_... SUCCESS REALUTR123
 *
 * Reads CF_CLIENT_SECRET from .env so it signs with the same key the real
 * Cashfree webhooks would. The bot's verifySignature then must produce the
 * same hash → if your bot's signature math is correct, you'll see verified=true
 * in the bot logs.
 */
require("dotenv").config();
const crypto = require("crypto");
const axios  = require("axios");

const transferId = process.argv[2];
const statusArg  = (process.argv[3] || "SUCCESS").toUpperCase();
const utr        = process.argv[4] || (statusArg === "SUCCESS" ? `TESTUTR${Date.now()}` : null);

if (!transferId) {
  console.error("Usage: node scripts/testCashfreeWebhook.js <transfer_id> [SUCCESS|FAILED] [utr]");
  process.exit(1);
}

const SECRET = process.env.CF_CLIENT_SECRET;
if (!SECRET) {
  console.error("CF_CLIENT_SECRET missing from .env — required to sign the webhook.");
  process.exit(1);
}

const WEBHOOK_URL = process.env.WEBHOOK_URL
  || `http://localhost:${process.env.API_PORT || 5000}/api/cashfree/webhook`;

// Build a webhook body that matches what Cashfree V2 actually sends
const event = statusArg === "SUCCESS" ? "TRANSFER_SUCCESS"
            : statusArg === "FAILED"  ? "TRANSFER_FAILED"
            : "TRANSFER_REVERSED";

const body = {
  event,
  data: {
    transfer: {
      transfer_id:    transferId,
      cf_transfer_id: `manual_${Date.now()}`,
      status:         statusArg,
      transfer_utr:   utr,
      failure_reason: statusArg === "FAILED" ? "Manual test failure" : null,
    },
  },
};

// Serialize EXACTLY like Cashfree would (no extra whitespace)
const rawBody  = JSON.stringify(body);
const timestamp = String(Date.now());

// Cashfree V2 signature: Base64(HMAC-SHA256(timestamp + rawBody, clientSecret))
const signedPayload = timestamp + rawBody;
const signature = crypto
  .createHmac("sha256", SECRET)
  .update(signedPayload)
  .digest("base64");

console.log("──────────────────────────────────────────────────────────────");
console.log("Sending manual Cashfree-style webhook");
console.log("  URL          :", WEBHOOK_URL);
console.log("  Event        :", event);
console.log("  transfer_id  :", transferId);
console.log("  status       :", statusArg);
console.log("  utr          :", utr || "(none)");
console.log("  timestamp    :", timestamp);
console.log("  signature    :", signature.slice(0, 24) + "…");
console.log("  body length  :", rawBody.length, "bytes");
console.log("──────────────────────────────────────────────────────────────");

(async () => {
  try {
    const res = await axios.post(WEBHOOK_URL, rawBody, {
      headers: {
        "Content-Type":         "application/json",
        "x-webhook-signature":  signature,
        "x-webhook-timestamp":  timestamp,
      },
      timeout: 30_000,
      validateStatus: () => true,   // see all responses, even 4xx/5xx
    });
    console.log("Bot response :", res.status, JSON.stringify(res.data, null, 2));
    if (res.data?.ok === true) {
      console.log("✅ Webhook accepted by bot. Check your bot logs for the next steps:");
      console.log("   - 'Cashfree webhook applied'");
      console.log("   - 'Pending payout FINALIZED as SUCCESS' (if SUCCESS)");
      console.log("   - 'Chat msg sent via WSS' (the paymentSent or paymentFailed template)");
    } else {
      console.log("⚠️  Bot returned ok=false. Reason:", res.data?.reason || "(unknown)");
      console.log("   Check bot logs for 'Cashfree webhook received' / 'signature INVALID'.");
    }
  } catch (err) {
    console.error("✗ Transport error:", err.message);
    console.error("   Webhook URL not reachable from this machine.");
    process.exit(1);
  }
})();
