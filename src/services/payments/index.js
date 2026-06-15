const razorpay = require("./razorpay");
const paywize  = require("./paywize");
const botStatusService = require("../botStatusService");
const logger = require("../../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Payments facade — selects the active provider per bot_config and exposes
//  the same processPayment(payDetails, amountINR, orderNo) contract the rest
//  of the bot already calls.
//
//  Two providers wired:
//    - razorpay  (RazorpayX Payouts — HTTP Basic auth + JSON, webhook HMAC-hex)
//    - paywize   (Paywize Payouts v3.0 — JWT + AES-256-GCM payloads, webhook
//                 HMAC-SHA256 with encrypted data field)
//
//  Admin picks ONE active provider via the Payments page → bot_config.
//  payment_provider. Default: razorpay (most common Indian payout
//  workflows). Switching is instant on next payment — no restart needed.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = { razorpay, paywize };
const DEFAULT_PROVIDER = "razorpay";

// Resolve the active provider for THIS payment. Reads bot_config on every
// call so the admin can flip providers from the dashboard and the next
// payout uses the new choice (caching is handled by botStatusService's
// 3-sec status cache + explicit invalidate on update).
async function getActiveProvider() {
  let providerName = DEFAULT_PROVIDER;
  try {
    const status = await botStatusService.getStatus();
    providerName = String(status?.payment_provider || DEFAULT_PROVIDER).toLowerCase();
  } catch (err) {
    logger.warn("getActiveProvider — bot_config read failed, falling back to default", {
      defaultProvider: DEFAULT_PROVIDER,
      error: err.message,
    });
  }
  const provider = PROVIDERS[providerName];
  if (!provider) {
    logger.error("Unknown payment_provider in bot_config — falling back to default", {
      configured: providerName,
      using:      DEFAULT_PROVIDER,
    });
    return PROVIDERS[DEFAULT_PROVIDER];
  }
  return provider;
}

// Synchronous lookup by name — used by webhook controllers (they know which
// provider's URL they were registered under, no DB read needed).
function getProviderByName(name) {
  const provider = PROVIDERS[String(name || "").toLowerCase()];
  if (!provider) throw new Error(`Unknown payment provider: ${name}`);
  return provider;
}

async function processPayment(payDetails, amountINR, orderNo) {
  const provider = await getActiveProvider();
  logger.info("Dispatching processPayment to active provider", {
    orderNo, provider: provider.name, amountINR,
  });
  return provider.processPayment(payDetails, amountINR, orderNo);
}

module.exports = {
  processPayment,
  getActiveProvider,
  getProviderByName,
  // Re-export individual providers so webhook controllers can import directly.
  razorpay,
  paywize,
};
