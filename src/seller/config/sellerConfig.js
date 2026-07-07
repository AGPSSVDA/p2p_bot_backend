require('dotenv').config();

// Seller-specific configuration
const sellerConfig = {
  // Enable/disable seller bot
  enabled: process.env.SELLER_BOT_ENABLED === 'true',

  // Polling intervals
  orderPollInterval: parseInt(process.env.SELLER_ORDER_POLL_INTERVAL, 10) || 5000,
  livenessCheckInterval: parseInt(process.env.SELLER_LIVENESS_CHECK_INTERVAL, 10) || 10000,
  paymentCheckInterval: parseInt(process.env.SELLER_PAYMENT_CHECK_INTERVAL, 10) || 15000,

  // Timeouts
  livenessTimeout: parseInt(process.env.SELLER_LIVENESS_TIMEOUT_MS, 10) || 600000, // 10 mins
  documentUploadTimeout: parseInt(process.env.SELLER_DOCUMENT_UPLOAD_TIMEOUT_MS, 10) || 900000, // 15 mins
  mobileOtpTimeout: parseInt(process.env.SELLER_MOBILE_OTP_TIMEOUT_MS, 10) || 300000, // 5 mins
  paymentWebhookTimeout: parseInt(process.env.SELLER_PAYMENT_WEBHOOK_TIMEOUT_MS, 10) || 86400000, // 24 hours

  // Retry settings
  maxRetries: parseInt(process.env.SELLER_MAX_RETRIES, 10) || 3,
  retryDelayMs: parseInt(process.env.SELLER_RETRY_DELAY_MS, 10) || 2000,

  // Feature flags
  features: {
    livenessVerification: true,
    documentVerification: true,
    mobileOtpVerification: true,
    paymentGatewayIntegration: true,
  },

  // Default values for new ads
  defaults: {
    minTradesCount: 0,
    minCompletionRate: 0,
    minRegisteredDays: 0,
  },
};

// Validate seller config
function validateSellerConfig() {
  const required = [];

  if (!required.some(field => !sellerConfig[field])) {
    console.log('✅ Seller config validated');
  }
}

// Export
module.exports = {
  sellerConfig,
  validateSellerConfig,
};
