require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
//  Central Config — SAPI v7.4 Official Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const config = {

  binance: {
    apiKey:    process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl:   'https://api.binance.com',

    // WSS base — per "How to handle C2C-messages and image v7.4" doc
    chatWssBase: 'wss://im.binance.com:443',

    // SAPI v7.4 Official Endpoints
    endpoints: {
      // Orders
      listOrders:      '/sapi/v1/c2c/orderMatch/listOrders',
      orderDetail:     '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
      markPaid:        '/sapi/v1/c2c/orderMatch/markOrderAsPaid',
      cancelOrder:     '/sapi/v1/c2c/orderMatch/cancelOrder',
      canCancel:       '/sapi/v1/c2c/orderMatch/checkIfAllowedCancelOrder',

      // Chat (Official v7.4)
      chatCredential:  '/sapi/v1/c2c/chat/retrieveChatCredential',
      chatMessages:    '/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination',
      markMsgRead:     '/sapi/v1/c2c/chat/markOrderMessagesAsRead',
      sendMessage:     '/sapi/v1/c2c/chat/sendMessage',
      imagePresign:    '/sapi/v1/c2c/chat/image/pre-signed-url',

      // Payment methods (own)
      paymentMethods:  '/sapi/v1/c2c/paymentMethod/getPayMethodByUserId',
    }
  },

  surepass: {
    // Accept either env name — pan-verify project uses SUREPASS_API_TOKEN
    token:    process.env.SUREPASS_TOKEN || process.env.SUREPASS_API_TOKEN,
    baseUrl:  'https://kyc-api.surepass.app',
    endpoint: '/api/v1/pan/pan',
    // Defensive: take only the first word so accidental "subset (or 'exact')"
    // inline-comment values from .env still parse correctly.
    nameMatchMode:        (process.env.PAN_NAME_MATCH_MODE        || 'subset').trim().split(/\s+/)[0],
    nameMismatchBehavior: (process.env.PAN_NAME_MISMATCH_BEHAVIOR || 'block').trim().split(/\s+/)[0],
  },

  // RazorpayX Payouts — HTTP Basic auth (key_id:key_secret), JSON payloads.
  // Webhook signature: HMAC-SHA256 of raw body with RAZORPAY_WEBHOOK_SECRET,
  // hex-encoded, sent in the 'x-razorpay-signature' header.
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID,
    keySecret:     process.env.RAZORPAY_KEY_SECRET,
    accountNumber: process.env.RAZORPAY_ACCOUNT_NUMBER,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    baseUrl:       'https://api.razorpay.com/v1',
  },

  // Paywize Payouts — V2 (AES-256-GCM) Encryption.
  //   Endpoints (live API):
  //     POST /api/v1/auth/clients/token   (JWT, 5 min TTL, encrypted payload)
  //     POST /api/v1/payout/initiate      (encrypted payload)
  //     GET  /api/v1/payout/status        (sender_id OR transaction_id)
  //     GET  /api/v1/payout/balance       (wallet_id)
  //   Webhook signature: HMAC-SHA256(rawBody, secretKey), hex-encoded.
  //   Header: 'X-Paywize-Signature: sha256=<hex>'
  //   Webhook URL is sent per-request as `callback_url` — NO dashboard URL
  //   to register, Paywize POSTs back to whatever URL we send.
  //   IP allowlist: every /api/v1/* endpoint is gated on the calling
  //   server's IP — you MUST add the deploy host's outbound IP via Paywize
  //   support / dashboard or you'll get 403 "Your IP address is not allowed".
  paywize: {
    apiKey:        process.env.PAYWIZE_API_KEY,
    secretKey:     process.env.PAYWIZE_SECRET_KEY,
    walletId:      process.env.PAYWIZE_WALLET_ID,
    webhookSecret: process.env.PAYWIZE_WEBHOOK_SECRET || process.env.PAYWIZE_SECRET_KEY,
    baseUrl:       process.env.PAYWIZE_BASE_URL || 'https://merchant.paywize.in',
    // Public URL Paywize calls back when payout status changes. Falls back
    // to '<APP_PUBLIC_URL>/api/paywize/webhook' if APP_PUBLIC_URL is set.
    // Without either, callback_url is omitted and Paywize won't notify us
    // (the poll loop still catches success/failure synchronously).
    callbackUrl:   process.env.PAYWIZE_CALLBACK_URL
                || (process.env.APP_PUBLIC_URL
                      ? `${String(process.env.APP_PUBLIC_URL).replace(/\/$/, "")}/api/paywize/webhook`
                      : undefined),
  },

  bot: {
    orderPollInterval:      parseInt(process.env.ORDER_POLL_INTERVAL,      10) || 8000,
    completionPollInterval: parseInt(process.env.COMPLETION_POLL_INTERVAL, 10) || 15000,
    panTimeoutMs:           parseInt(process.env.PAN_TIMEOUT_MS,           10) || 600000,
    panReminderMs:          parseInt(process.env.PAN_REMINDER_MS,          10) || 300000,
    maxPanRetries:          parseInt(process.env.MAX_PAN_RETRIES,          10) || 3,
    // Cap on the "submit correct bank account in chat" retry flow that
    // fires when KYC ↔ Bank Holder mismatches but PAN ↔ KYC passed.
    maxBankRetries:         parseInt(process.env.MAX_BANK_RETRIES,         10) || 2,
    // NOTE: the old MAX_PAYMENT_AMOUNT env cap was removed in favour of a
    // dynamically-derived hard cap (neft_max_amount × 50) inside the payment
    // provider modules. The IMPS/NEFT/RTGS limits on the Payments page are
    // the only source of truth for payment limits — no env override needed.
    tdsPercent:             parseFloat(process.env.TDS_PERCENT)               || 1,
    tan:                    process.env.TAN || 'JDHT04147D',

    // Auto-cancel orders this many ms BEFORE Binance's own deadline expires
    // (default 60 sec). Set to 0 to disable proactive cancel.
    autoCancelBufferMs:     parseInt(process.env.AUTO_CANCEL_BUFFER_MS, 10) || 60000,

    // Configurable messages — Req #1, #2, #6
    welcomeMessage:    process.env.WELCOME_MESSAGE    || null,
    panRequestMessage: process.env.PAN_REQUEST_MESSAGE || null,
    thankYouMessage:   process.env.THANK_YOU_MESSAGE  || null,
  },

  // Feature flags — set by validateConfig()
  features: {
    panVerification: false,
    autoPayment:     false,
  },

  env:      process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Startup Validation
// ─────────────────────────────────────────────────────────────────────────────
function validateConfig() {
  const required = [
    ['BINANCE_API_KEY',    config.binance.apiKey],
    ['BINANCE_SECRET_KEY', config.binance.secretKey],
  ];

  const missing = required
    .filter(([, val]) => !val || String(val).startsWith('your_'))
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error('\n❌ Missing required keys in .env:');
    missing.forEach(k => console.error(`   → ${k}`));
    console.error('\nSee .env.example for reference.\n');
    process.exit(1);
  }

  config.features.panVerification = !!(
    config.surepass.token && !config.surepass.token.startsWith('your_')
  );

  // Either provider's creds present = auto-payment available. Active provider
  // is selected at runtime from bot_config.payment_provider; both can be
  // configured simultaneously and the admin flips between them at will.
  const razorpayReady = !!(
    config.razorpay.keyId && !String(config.razorpay.keyId).startsWith('your_') &&
    config.razorpay.keySecret && config.razorpay.accountNumber
  );
  const paywizeReady = !!(
    config.paywize.apiKey && !String(config.paywize.apiKey).startsWith('your_') &&
    config.paywize.secretKey && config.paywize.walletId
  );
  config.features.autoPayment = razorpayReady || paywizeReady;

  const providersConfigured = [
    razorpayReady ? 'RazorpayX' : null,
    paywizeReady  ? 'Paywize'   : null,
  ].filter(Boolean).join(' + ') || 'none';

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      Binance P2P Bot — Feature Status        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Binance SAPI v7.4   : ✅ ENABLED             ║');
  console.log(`║  PAN Verification    : ${config.features.panVerification ? '✅ ENABLED (Surepass)  ' : '⏸️  SKIPPED (Phase 2)  '}  ║`);
  console.log(`║  Auto Payment        : ${config.features.autoPayment     ? `✅ ENABLED (${providersConfigured})` : '⏸️  SKIPPED (Phase 3)  '}`);
  console.log('╚══════════════════════════════════════════════╝\n');
}

module.exports = { config, validateConfig };
