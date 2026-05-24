const axios = require("axios");
const crypto = require("crypto");
const { config } = require("../config/config");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Cashfree Verifications — Bank Account verification (penny-drop)
//
//  Endpoint: POST {verificationBaseUrl}/bank-account/sync
//  Returns the REAL account-holder name as registered with the bank (a more
//  trustworthy signal than the seller-supplied name Binance ships in the
//  order detail).
//
//  Optional `name` field is sent for Cashfree's own name-match score, but
//  the bot's existing tokenIntersectionMatch is used downstream — we only
//  need the bank's authoritative name back.
//
//  Failure modes (all return { ok: false, reason, ... }):
//    - Verifications product not enabled on the Cashfree account
//    - Invalid account / IFSC
//    - Network / timeout
//    - Rate limit
//
//  Caller decides the fallback (typically: use Binance-provided account
//  holder name when this returns ok=false).
// ─────────────────────────────────────────────────────────────────────────────

function newRequestId() {
  return `verify_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function headers() {
  return {
    "Content-Type":    "application/json",
    "x-client-id":     config.cashfree.clientId,
    "x-client-secret": config.cashfree.clientSecret,
    "x-api-version":   config.cashfree.apiVersion,
    "x-request-id":    newRequestId(),
  };
}

/**
 * Verify a bank account and fetch the holder's name as registered at the bank.
 *
 * @param {Object} opts
 * @param {string} opts.accountNumber  Bank account number
 * @param {string} opts.ifsc            IFSC code (case insensitive)
 * @param {string} [opts.name]          PAN/expected name — sent for
 *                                      Cashfree's own match-score (optional)
 * @param {string} [opts.orderNo]       For log correlation
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   nameAtBank?: string,
 *   accountStatus?: string,
 *   accountStatusCode?: string,
 *   nameMatchScore?: string,
 *   nameMatchResult?: string,
 *   bankName?: string,
 *   branchName?: string,
 *   referenceId?: string|number,
 *   reason?: string,
 *   httpStatus?: number,
 *   raw?: any
 * }>}
 */
async function verifyBankAccount({ accountNumber, ifsc, name, orderNo } = {}) {
  // Pre-flight: credentials present?
  if (!config.cashfree.clientId || !config.cashfree.clientSecret) {
    return { ok: false, reason: "no_credentials" };
  }
  const acc  = String(accountNumber || "").trim();
  const code = String(ifsc || "").trim().toUpperCase();
  if (!acc || !code) {
    return { ok: false, reason: "missing_input" };
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
    return { ok: false, reason: "bad_ifsc_format" };
  }
  if (!/^[A-Za-z0-9]{4,25}$/.test(acc)) {
    return { ok: false, reason: "bad_account_format" };
  }

  const body = { bank_account: acc, ifsc: code };
  if (name) body.name = String(name).slice(0, 100);

  const url = `${config.cashfree.verificationBaseUrl}/bank-account/sync`;

  logger.info("Cashfree bank verification → request", {
    orderNo:        orderNo || "(none)",
    accountNumber:  `${acc.slice(0, 4)}…${acc.slice(-4)}`,  // partial mask
    ifsc:           code,
    nameProvided:   !!name,
    env:            config.cashfree.env,
  });

  let res;
  try {
    res = await axios({
      method:  "POST",
      url,
      headers: headers(),
      data:    body,
      timeout: 30_000,
      validateStatus: () => true,
    });
  } catch (err) {
    logger.warn("Cashfree bank verification → transport error", {
      orderNo: orderNo || "(none)",
      error:   err.message,
    });
    return { ok: false, reason: "transport_error", error: err.message };
  }

  const status = res.status;
  const data   = res.data || {};
  const httpOk = status >= 200 && status < 300;

  // The Cashfree response in V2 wraps the actual fields under `data`
  // for some endpoints and flat for others — handle both.
  const payload = data?.data || data;
  const nameAtBank        = payload?.name_at_bank        || payload?.nameAtBank        || null;
  const accountStatus     = payload?.account_status      || payload?.accountStatus     || null;
  const accountStatusCode = payload?.account_status_code || payload?.accountStatusCode || null;
  const nameMatchScore    = payload?.name_match_score    || payload?.nameMatchScore    || null;
  const nameMatchResult   = payload?.name_match_result   || payload?.nameMatchResult   || null;
  const bankName          = payload?.bank_name           || payload?.bankName          || null;
  const branchName        = payload?.branch_name         || payload?.branchName        || null;
  const referenceId       = payload?.reference_id        || payload?.referenceId       || null;

  if (!httpOk) {
    // Common when the Verifications suite isn't enabled on the merchant
    // account; surface a clear reason so the caller falls back gracefully.
    const errorCode = data?.code || data?.error_code || null;
    const errorMsg  = data?.message || data?.error_description || "verification failed";
    logger.warn("Cashfree bank verification → API error", {
      orderNo: orderNo || "(none)",
      httpStatus: status,
      errorCode,
      errorMsg,
    });
    return {
      ok:         false,
      reason:     errorCode || "api_error",
      httpStatus: status,
      error:      errorMsg,
      raw:        data,
    };
  }

  if (!nameAtBank) {
    logger.warn("Cashfree bank verification → 2xx but no name_at_bank", {
      orderNo: orderNo || "(none)",
      accountStatus, accountStatusCode, body: payload,
    });
    return {
      ok:         false,
      reason:     "no_name_returned",
      httpStatus: status,
      raw:        data,
    };
  }

  logger.info("Cashfree bank verification → success", {
    orderNo:           orderNo || "(none)",
    nameAtBank,
    accountStatus,
    accountStatusCode,
    nameMatchScore:    nameMatchScore   || "(n/a)",
    nameMatchResult:   nameMatchResult  || "(n/a)",
    bankName,
    branchName,
    referenceId,
  });

  return {
    ok:                true,
    nameAtBank,
    accountStatus,
    accountStatusCode,
    nameMatchScore,
    nameMatchResult,
    bankName,
    branchName,
    referenceId,
    raw:               data,
  };
}

module.exports = { verifyBankAccount };
