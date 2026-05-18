// ─────────────────────────────────────────────────────────────────────────────
//  Chat-message catalog — DB-backed
//
//  All template text lives in the template_groups / template_messages MySQL
//  tables (see src/config/mysql.js TEMPLATE_DEFAULTS for the seeded defaults).
//  This file is a thin async facade: each function resolves a template_key
//  against the DB via messageService and substitutes placeholders.
//
//  Edit messages from the frontend "Chat Templates" page — changes take
//  effect within ~30 seconds (messageService cache TTL).
// ─────────────────────────────────────────────────────────────────────────────

const messageService = require("../services/messageService");

const inr = messageService.inr;

const MESSAGES = {
  WELCOME: (sellerName, amount, asset) =>
    messageService.get("welcome", { sellerName, amount, asset }),

  PAN_REQUEST: () => messageService.get("panRequest"),

  PAN_NOT_FOUND: () => messageService.get("panNotFound"),

  PAN_IMAGE_REJECTED: () => messageService.get("panImageRejected"),

  PAN_INVALID_FORMAT: () => messageService.get("panInvalidFormat"),

  PAN_API_INVALID: (reason) => messageService.get("panApiInvalid", { reason }),

  PAN_VERIFIED_TDS: (_pan, tds) =>
    messageService.get("panVerifiedTds", {
      preTDS: inr(tds?.preTDS),
      tds: inr(tds?.tds),
      postTDS: inr(tds?.postTDS),
    }),

  TDS_INFO: (tds) =>
    messageService.get("tdsInfo", messageService.tdsInfoVars(tds)),

  TDS_CONSENT: (tds) =>
    messageService.get("tdsConsent", {
      postTDS: inr(tds?.postTDS),
      tds: inr(tds?.tds),
    }),

  TDS_CONSENT_RETRY: () => messageService.get("tdsConsentRetry"),

  CONSENT_RECEIVED: () => messageService.get("consentReceived"),

  PAYMENT_SENT: (_tds, method, utr, tan) =>
    messageService.get("paymentSent", { method, utr, tan }),

  MANUAL_PAYMENT_PENDING: (tds, method) =>
    messageService.get("manualPaymentPending", {
      postTDS: inr(tds?.postTDS),
      method,
    }),

  PAN_REMINDER: () => messageService.get("panReminder"),

  PAN_LAST_WARNING: () => messageService.get("panLastWarning"),

  ORDER_CANCELLED: () => messageService.get("orderCancelled"),

  PAN_MAX_RETRIES: () => messageService.get("panMaxRetries"),

  NAME_MISMATCH: () => messageService.get("nameMismatch"),

  PAN_API_DOWN: () => messageService.get("panApiDown"),

  ORDER_CANCELLED_REMOTE: () => messageService.get("orderCancelledRemote"),

  SYSTEM_ERROR: () => messageService.get("systemError"),

  ESCALATED: () => messageService.get("escalated"),

  PAYMENT_FAILED: () => messageService.get("paymentFailed"),

  THANK_YOU: (asset, cryptoAmount, orderNo) =>
    messageService.get("thankYou", { asset, cryptoAmount, orderNo }),

  WAIT_PROCESSING: () => messageService.get("waitProcessing"),

  WAIT_RELEASE: (method) =>
    messageService.get("waitRelease", { method: method || "account" }),
};

module.exports = { MESSAGES };
