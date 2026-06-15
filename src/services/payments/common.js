const crypto = require("crypto");
const { config } = require("../../config/config");
const botStatusService = require("../botStatusService");
const orderDbService = require("../orderDbService");
const logger = require("../../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Shared payment-provider helpers (provider-agnostic).
//
//  Every concrete provider (razorpay.js, paywize.js) imports from this file
//  for: pre-flight gates, deterministic ID generation, transfer-mode chooser,
//  manual-fallback response shape. Keeps the provider files focused on
//  HTTP/signature wiring only.
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic transfer/reference id from orderNo. Hashed so the plaintext
// "p2p|<orderNo>" never reaches the upstream provider — only `tx_<hex>`.
function deterministicTransferId(orderNo) {
  const hash = crypto.createHash("sha256").update(`p2p|${orderNo}`).digest("hex").slice(0, 24);
  return `tx_${hash}`;
}

// Deterministic beneficiary key — same bank account always maps to the same
// id across orders, so the provider de-dupes beneficiary creation.
function deterministicBeneficiaryId({ accountNumber, ifsc }) {
  const input = `bank|${accountNumber}|${String(ifsc).toUpperCase()}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
  return `b_${hash}`;
}

// Manual-fallback response shape (consumed by orderHandler._processPaymentFlow).
function manual(reason, amountINR, payDetails, extras = {}) {
  return {
    manual: true,
    reason,
    amount: amountINR,
    mode:   payDetails?.methodName || null,
    ...extras,
  };
}

// ── Dynamic transfer-mode chooser ────────────────────────────────────────────
//   amount  <  imps_max_amount           → IMPS
//   imps_max ≤ amount < neft_max         → NEFT
//   amount  ≥  neft_max                  → RTGS
//
//   PLUS: if today's IMPS total (rolling 24h, post-TDS amounts only) would
//   exceed imps_daily_cap when this transfer is added, the IMPS-tier order
//   falls back to NEFT.
//
//   Returns { mode: 'IMPS'|'NEFT'|'RTGS', reason, snapshot }
async function chooseTransferMode(amountINR) {
  const limits      = await botStatusService.getPaymentLimits();
  const impsUsed24h = await orderDbService.getImpsAmountLast24h();

  let mode, reason;
  if (amountINR < limits.impsMaxAmount) {
    if (impsUsed24h + amountINR <= limits.impsDailyCap) {
      mode = "IMPS";
      reason = "amount_below_imps_max";
    } else {
      mode = "NEFT";
      reason = "imps_daily_cap_exhausted";
    }
  } else if (amountINR < limits.neftMaxAmount) {
    mode = "NEFT";
    reason = "amount_in_neft_band";
  } else {
    mode = "RTGS";
    reason = "amount_above_neft_max";
  }

  return {
    mode,
    reason,
    snapshot: {
      amountINR,
      impsMaxAmount:      limits.impsMaxAmount,
      neftMaxAmount:      limits.neftMaxAmount,
      impsDailyCap:       limits.impsDailyCap,
      impsUsedToday:      impsUsed24h,
      impsRemainingToday: Math.max(0, limits.impsDailyCap - impsUsed24h),
    },
  };
}

// ── Pre-flight gates that every provider must enforce identically ────────────
//   Returns null when all checks pass, or a `manual()` response when one
//   gate fails so the caller can `return` it directly.
async function runCommonPreflightGates({ payDetails, amountINR, orderNo, providerName }) {
  // 1. Provider creds present? (caller passes false if any required env var is missing)
  if (!providerCredsPresent(providerName)) {
    logger.info("Auto payment skipped — provider credentials missing", {
      orderNo, provider: providerName, amountINR,
    });
    return manual("no_credentials", amountINR, payDetails);
  }
  // 2. UI auto_payout toggle ON?
  let autoPayoutEnabled = false;
  try {
    autoPayoutEnabled = await botStatusService.isAutoPayoutEnabled();
  } catch (_) { /* default to OFF on DB hiccup — safer */ }
  if (!autoPayoutEnabled) {
    logger.info("Auto payment skipped — auto_payout toggle is OFF", {
      orderNo, provider: providerName, amountINR,
    });
    return manual("toggle_off", amountINR, payDetails);
  }
  if (!(amountINR > 0)) {
    throw new Error(`Invalid amount: ${amountINR}`);
  }
  // 3. Has a bank account? (RazorpayX / Paywize need a bank account, not UPI)
  const hasBank = !!(payDetails?.accountNo && payDetails?.ifscCode);
  if (!hasBank) {
    logger.warn("No bank account — auto payout cannot pay UPI; falling back to manual", {
      orderNo, provider: providerName,
      upi: payDetails?.upiId || "(none)",
    });
    return manual("upi_only", amountINR, payDetails);
  }
  // 4. Holder name sanitisable?
  const safeName = String(payDetails.accountName || "Seller")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!safeName) {
    logger.warn("Account-holder name unusable — manual", { orderNo, provider: providerName });
    return manual("bad_name", amountINR, payDetails);
  }
  // 5. IFSC format
  const ifscNorm = String(payDetails.ifscCode || "").trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscNorm)) {
    logger.warn("IFSC code malformed — falling back to manual", {
      orderNo, provider: providerName, ifsc: ifscNorm,
    });
    return manual("bad_ifsc", amountINR, payDetails);
  }
  // 6. Account-number format
  const accountNorm = String(payDetails.accountNo || "").trim();
  if (!/^[A-Za-z0-9]{4,25}$/.test(accountNorm)) {
    logger.warn("Bank account number malformed — manual", {
      orderNo, provider: providerName, accountNo: accountNorm,
    });
    return manual("bad_account", amountINR, payDetails);
  }
  return null;   // all gates passed
}

// Each provider declares its own required env vars. Centralising this means
// the gate check stays in lockstep with the actual provider logic.
function providerCredsPresent(providerName) {
  if (providerName === "razorpay") {
    return !!(config.razorpay?.keyId && config.razorpay?.keySecret && config.razorpay?.accountNumber);
  }
  if (providerName === "paywize") {
    return !!(config.paywize?.apiKey && config.paywize?.secretKey && config.paywize?.walletId);
  }
  return false;
}

// HTTP helper used by both providers — never throws on non-2xx, returns a
// structured { ok, status, body, error? } so the caller branches explicitly.
async function call({ method, url, headers, data, params, timeout = 30_000, axiosOpts = {} }) {
  const axios = require("axios");
  try {
    const res = await axios({
      method, url, headers, data, params, timeout,
      validateStatus: () => true,
      ...axiosOpts,
    });
    return {
      ok:     res.status >= 200 && res.status < 300,
      status: res.status,
      body:   res.data,
      headers: res.headers,
    };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
}

module.exports = {
  deterministicTransferId,
  deterministicBeneficiaryId,
  manual,
  chooseTransferMode,
  runCommonPreflightGates,
  providerCredsPresent,
  call,
};
