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

  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID,
    keySecret:     process.env.RAZORPAY_KEY_SECRET,
    accountNumber: process.env.RAZORPAY_ACCOUNT_NUMBER,
    baseUrl:       'https://api.razorpay.com/v1',
  },

  cashfree: {
    clientId:            process.env.CF_CLIENT_ID,
    clientSecret:        process.env.CF_CLIENT_SECRET,
    env:                 process.env.CF_ENV || 'SANDBOX',
    apiVersion:          process.env.CF_API_VERSION || '2024-01-01',
    defaultFundsourceId: process.env.CF_DEFAULT_FUNDSOURCE_ID || '',
    get baseUrl() {
      return String(this.env).toUpperCase() === 'PROD'
        ? 'https://api.cashfree.com/payout'
        : 'https://sandbox.cashfree.com/payout';
    },
    // Cashfree's Verifications product (penny-drop bank-account verification).
    // Requires the Verifications suite to be enabled on the Cashfree account;
    // the same client_id / client_secret authenticate against it.
    get verificationBaseUrl() {
      return String(this.env).toUpperCase() === 'PROD'
        ? 'https://api.cashfree.com/verification'
        : 'https://sandbox.cashfree.com/verification';
    },
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
    // dynamically-derived hard cap (neft_max_amount × 50) inside
    // paymentService. The IMPS/NEFT/RTGS limits on the Payments page are now
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
  config.features.autoPayment = !!(
    config.cashfree.clientId && !config.cashfree.clientId.startsWith('your_') &&
    config.cashfree.clientSecret
  );

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      Binance P2P Bot — Feature Status        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Binance SAPI v7.4   : ✅ ENABLED             ║');
  console.log(`║  PAN Verification    : ${config.features.panVerification ? '✅ ENABLED (Surepass)  ' : '⏸️  SKIPPED (Phase 2)  '}  ║`);
  console.log(`║  Auto Payment        : ${config.features.autoPayment     ? `✅ ENABLED (Cashfree ${config.cashfree.env}) ` : '⏸️  SKIPPED (Phase 3)  '} ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
}

module.exports = { config, validateConfig };
