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

  PAN_VERIFIED_TDS: (pan, tds, panName) =>
    messageService.get("panVerifiedTds", {
      pan:     pan     || "—",
      panName: panName || "—",
      preTDS:  inr(tds?.preTDS),
      tds:     inr(tds?.tds),
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

  NAME_MISMATCH: (vars = {}) =>
    messageService.get("nameMismatch", {
      panName:            vars.panName            || "—",
      kycName:            vars.kycName            || "—",
      accountName:        vars.accountName        || "—",
      mismatchedSources:  vars.mismatchedSources  || "—",
    }),

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

  // Returning-seller shortcut: PAN already verified in a prior trade, so the
  // bot sends the three-block summary (Overview / Approval / Summary) instead
  // of running the welcome + PAN-request + consent flow again.
  // Returns the full ordered list of messages to send sequentially.
  RETURNING_SELLER_TDS: ({ previousOrderNo, pan, panName, tds }) =>
    messageService.getAll("returningSellerTdsApplied", {
      previousOrderNo: previousOrderNo || "—",
      pan:             pan || "—",
      panName:         panName || "—",
      preTDS:          inr(tds?.preTDS),
      tds:             inr(tds?.tds),
      postTDS:         inr(tds?.postTDS),
    }),
};

module.exports = { MESSAGES };
