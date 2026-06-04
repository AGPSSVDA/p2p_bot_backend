const axios = require("axios");
const { config } = require("../config/config");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Surepass Bank Verification — replaces the previous Cashfree penny-drop.
//
//  Endpoint: POST https://kyc-api.surepass.io/api/v1/bank-verification/
//  Auth:     Authorization: Bearer <SUREPASS_API_TOKEN>
//  Body:     { id_number, ifsc, ifsc_details: true }
//
//  Returns the REAL account-holder name as registered with the bank in
//  `data.full_name`. The bot's existing tokenIntersectionMatch is then used
//  to match this against the Binance KYC name.
//
//  Failure modes (all return { ok: false, reason, ... }):
//    - missing Surepass token in env
//    - bad IFSC / account-number format (skip the call, save quota)
//    - 4xx / 5xx from Surepass (reason carries Surepass's message_code)
//    - account doesn't exist  (data.status !== "success" or empty full_name)
//    - network / timeout
// ─────────────────────────────────────────────────────────────────────────────

const SUREPASS_BANK_URL = "https://kyc-api.surepass.io/api/v1/bank-verification/";

/**
 * Verify a bank account and fetch the holder's name as registered at the bank.
 *
 * @param {Object} opts
 * @param {string} opts.accountNumber  Bank account number
 * @param {string} opts.ifsc            IFSC code (case insensitive)
 * @param {string} [opts.name]          Expected name — kept for parity with
 *                                      the old Cashfree signature; Surepass
 *                                      doesn't accept this field.
 * @param {string} [opts.orderNo]       For log correlation
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   nameAtBank?: string,
 *   accountStatus?: string,
 *   accountExists?: boolean,
 *   bankName?: string,
 *   branchName?: string,
 *   referenceId?: string,
 *   reason?: string,
 *   httpStatus?: number,
 *   raw?: any,
 * }>}
 */
async function verifyBankAccount({ accountNumber, ifsc, /* name, */ orderNo } = {}) {
  // Pre-flight: token present?
  if (!config.surepass?.token) {
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

  logger.info("Surepass bank verification → request", {
    orderNo:       orderNo || "(none)",
    accountNumber: `${acc.slice(0, 4)}…${acc.slice(-4)}`,   // partial mask
    ifsc:          code,
  });

  let res;
  try {
    res = await axios.post(
      SUREPASS_BANK_URL,
      {
        id_number:    acc,
        ifsc:         code,
        ifsc_details: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${config.surepass.token}`,
        },
        timeout:        30_000,
        validateStatus: () => true,
      }
    );
  } catch (err) {
    logger.warn("Surepass bank verification → transport error", {
      orderNo: orderNo || "(none)",
      error:   err.message,
    });
    return { ok: false, reason: "transport_error", error: err.message };
  }

  const status     = res.status;
  const body       = res.data || {};
  const httpOk     = status >= 200 && status < 300;
  const apiSuccess = body.success === true && (body.status_code == null || body.status_code === 200);

  if (!httpOk || !apiSuccess) {
    const reason = body.message_code || body.message || `http_${status}`;
    logger.warn("Surepass bank verification → API error", {
      orderNo:    orderNo || "(none)",
      httpStatus: status,
      reason,
      raw:        typeof body === "string" ? body.slice(0, 300) : body,
    });
    return {
      ok:         false,
      reason,
      httpStatus: status,
      raw:        body,
    };
  }

  const data       = body.data || {};
  const nameAtBank = String(data.full_name || "").trim();

  // Surepass returned 200 but the bank account didn't resolve — e.g. wrong
  // account number, account closed, or IMPS network couldn't reach the bank.
  if (!nameAtBank || data.status === "failure" || data.account_exists === false) {
    logger.warn("Surepass bank verification → no usable result", {
      orderNo:       orderNo || "(none)",
      accountExists: data.account_exists,
      status:        data.status,
      remarks:       data.remarks || "(none)",
    });
    return {
      ok:         false,
      reason:     data.status === "failure" ? "account_not_found" : "no_name_returned",
      httpStatus: status,
      raw:        body,
    };
  }

  const ifscD = data.ifsc_details || {};

  logger.info("Surepass bank verification → success", {
    orderNo:       orderNo || "(none)",
    nameAtBank,
    accountExists: data.account_exists,
    bankName:      ifscD.bank_name || "(n/a)",
    branchName:    ifscD.branch || "(n/a)",
    referenceId:   data.imps_ref_no || data.client_id || "(n/a)",
  });

  return {
    ok:             true,
    nameAtBank,
    accountStatus:  data.status,
    accountExists:  data.account_exists,
    bankName:       ifscD.bank_name || null,
    branchName:     ifscD.branch || null,
    referenceId:    data.imps_ref_no || data.client_id || null,
    raw:            body,
  };
}

module.exports = { verifyBankAccount };
