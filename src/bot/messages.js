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

  // Returns the FULL array of "tds info" blocks so admin-added variations
  // (step_order 2, 3, …) all get sent — each block has its own placeholder
  // substitution from the same vars map, so {tds} in every block resolves.
  TDS_INFO: (tds) =>
    messageService.getAll("tdsInfo", messageService.tdsInfoVars(tds)),

  TDS_CONSENT: (tds) =>
    messageService.get("tdsConsent", {
      postTDS: inr(tds?.postTDS),
      tds: inr(tds?.tds),
    }),

  TDS_CONSENT_RETRY: () => messageService.get("tdsConsentRetry"),

  CONSENT_RECEIVED: () => messageService.get("consentReceived"),

  PAYMENT_SENT: (tds, method, utr, tan) =>
    messageService.get("paymentSent", {
      method,
      utr,
      tan,
      tds:     inr(tds?.tds),
      postTDS: inr(tds?.postTDS),
      preTDS:  inr(tds?.preTDS),
    }),

  // Sent when the payment provider accepted the transfer but the partner bank
  // hasn't confirmed settlement within the 75-sec poll window. The real UTR
  // will arrive later via the provider webhook → orderHandler.finalizePayoutSuccess
  // which then sends the full PAYMENT_SENT template.
  PAYMENT_PROCESSING: (tds, method) =>
    messageService.get("paymentProcessing", {
      method,
      tds:     inr(tds?.tds),
      postTDS: inr(tds?.postTDS),
      preTDS:  inr(tds?.preTDS),
    }),

  MANUAL_PAYMENT_PENDING: (tds, method) =>
    messageService.get("manualPaymentPending", {
      postTDS: inr(tds?.postTDS),
      method,
    }),

  MANUAL_PAYMENT_ABOVE_LIMIT: ({ amount, limit, method }) =>
    messageService.get("manualPaymentAboveLimit", {
      amount: inr(amount),
      limit:  inr(limit),
      method: method || "—",
    }),

  MANUAL_PAYMENT_UPI: ({ upi, postTDS }) =>
    messageService.get("manualPaymentUpi", {
      upi:     upi || "—",
      postTDS: inr(postTDS),
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

  // Returns the FULL array of "thank you" blocks (one chat send per block).
  // Admin can add up to 5 variations from the Chat Templates page and all
  // are sent in step_order with a short delay between each.
  THANK_YOU: (asset, cryptoAmount, orderNo) =>
    messageService.getAll("thankYou", { asset, cryptoAmount, orderNo }),

  WAIT_PROCESSING: () => messageService.get("waitProcessing"),

  WAIT_RELEASE: (method) =>
    messageService.get("waitRelease", { method: method || "account" }),

  // Returning-seller shortcut: PAN already verified in a prior trade, so the
  // bot sends the multi-block summary (Overview / Approval / Summary) instead
  // of running the welcome + PAN-request + consent flow again.
  //
  // Vars available in every block (all editable in Chat Templates UI):
  //   {kycName}          — seller's Binance KYC name (greeting)
  //   {sellerNickname}   — seller's Binance public handle
  //   {previousOrderNo}  — order number of their prior completed order
  //   {pan}              — verified PAN on file
  //   {panName}          — name on the PAN (from Surepass)
  //   {preTDS} {tds} {postTDS} — rupee amounts for the current order
  RETURNING_SELLER_TDS: ({
    previousOrderNo, pan, panName, kycName, sellerNickname, tds,
  }) =>
    messageService.getAll("returningSellerTdsApplied", {
      previousOrderNo: previousOrderNo || "—",
      pan:             pan || "—",
      panName:         panName || "—",
      kycName:         kycName || panName || sellerNickname || "Customer",
      sellerNickname:  sellerNickname || "—",
      preTDS:          inr(tds?.preTDS),
      tds:             inr(tds?.tds),
      postTDS:         inr(tds?.postTDS),
    }),
};

module.exports = { MESSAGES };
