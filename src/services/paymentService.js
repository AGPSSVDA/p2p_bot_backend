const axios = require('axios');
const crypto = require('crypto');
const { config } = require('../config/config');
const { formatINR } = require('../utils/helpers');
const botStatusService = require('./botStatusService');
const orderDbService = require('./orderDbService');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Payment Service — Cashfree Payouts V2
//
//  Exports `processPayment(payDetails, amountINR, orderNo)` with the same
//  contract as before:
//    • { manual: true,  amount, mode }                       → falls back
//    • { payoutId, status, mode, amount, utr }               → success/pending
//    • throws Error                                          → hard failure
//
//  Behaviour:
//    1. If no Cashfree credentials configured → manual fallback.
//    2. If `auto_payout` toggle on bot_config is OFF → manual fallback.
//    3. If seller did NOT provide a bank account (UPI-only) → manual
//       fallback. Cashfree disabled UPI wallet payouts platform-wide.
//    4. If account / IFSC / holder-name fail format checks → manual
//       fallback (Cashfree would reject them anyway).
//    5. Otherwise: create beneficiary (with conflict resolution), initiate
//       transfer (IMPS / NEFT / RTGS chosen by amount + bot_config limits,
//       no upper amount cap — RTGS handles arbitrarily large transfers),
//       poll for terminal status.
//
//  Determinism / idempotency:
//    - beneficiary_id is hashed from (account_no + IFSC) — repeat payments
//      to the same account reuse the same beneficiary at Cashfree.
//    - transfer_id is hashed from orderNo — a retry against the same order
//      hits Cashfree as a duplicate (which we then poll instead of double
//      paying).
// ─────────────────────────────────────────────────────────────────────────────

function newRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function deterministicBeneficiaryId({ accountNumber, ifsc }) {
  const input = `bank|${accountNumber}|${String(ifsc).toUpperCase()}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
  return `b_${hash}`;
}

function deterministicTransferId(orderNo) {
  const hash = crypto.createHash('sha256').update(`p2p|${orderNo}`).digest('hex').slice(0, 24);
  return `tx_${hash}`;
}

function v2Headers() {
  return {
    'Content-Type':    'application/json',
    'x-client-id':     config.cashfree.clientId,
    'x-client-secret': config.cashfree.clientSecret,
    'x-api-version':   config.cashfree.apiVersion,
    'x-request-id':    newRequestId(),
  };
}

// Wrap an axios call so transport errors come back as a structured
// {ok, status, body} object rather than throwing.
async function call({ method, url, headers, data, params, timeout = 30_000 }) {
  try {
    const res = await axios({
      method, url, headers, data, params, timeout,
      validateStatus: () => true,
    });
    return {
      ok:     res.status >= 200 && res.status < 300,
      status: res.status,
      body:   res.data,
    };
  } catch (err) {
    return {
      ok:     false,
      status: 0,
      body:   null,
      error:  err.message,
    };
  }
}

// ─── Cashfree wrappers ───────────────────────────────────────────────────────

async function createBeneficiary(payload) {
  return call({
    method:  'POST',
    url:     `${config.cashfree.baseUrl}/beneficiary`,
    headers: v2Headers(),
    data:    payload,
  });
}

async function v1AuthorizeToken() {
  const r = await call({
    method:  'POST',
    url:     `${config.cashfree.baseUrl}/v1/authorize`,
    headers: {
      'Content-Type':    'application/json',
      'X-Client-Id':     config.cashfree.clientId,
      'X-Client-Secret': config.cashfree.clientSecret,
    },
  });
  if (!r.ok || !r.body?.data?.token) return null;
  return r.body.data.token;
}

// V1 lookup — used only when a 409 conflict_with_existing_beneficiary tells
// us the account is mapped to a beneficiary_id we don't know about. Returns
// that legacy id so we can transfer against it instead of failing.
async function lookupBeneByAccount({ accountNumber, ifsc }) {
  if (!accountNumber || !ifsc) return null;
  const token = await v1AuthorizeToken();
  if (!token) return null;
  const lookup = await call({
    method:  'GET',
    url:     `${config.cashfree.baseUrl}/v1/getBeneId`,
    headers: { Authorization: `Bearer ${token}` },
    params:  { bankAccount: accountNumber, ifsc },
  });
  return lookup.body?.data?.beneId || null;
}

async function initiateTransfer(payload) {
  return call({
    method:  'POST',
    url:     `${config.cashfree.baseUrl}/transfers`,
    headers: v2Headers(),
    data:    payload,
  });
}

async function getTransferStatus(transferId) {
  return call({
    method:  'GET',
    url:     `${config.cashfree.baseUrl}/transfers`,
    headers: v2Headers(),
    params:  { transfer_id: transferId },
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Helper — every manual fallback returns the same shape, just with a
// distinct `reason` code so the caller (orderHandler) can pick the right
// chat template.
function manual(reason, amountINR, payDetails, extras = {}) {
  return {
    manual: true,
    reason,
    amount: amountINR,
    mode:   payDetails.methodName,
    ...extras,
  };
}

// ── Dynamic transfer-mode chooser ────────────────────────────────────────────
//   amount < imps_max_amount                       → IMPS
//   imps_max_amount ≤ amount < neft_max_amount     → NEFT
//   amount ≥ neft_max_amount                       → RTGS
//
//   PLUS: if today's IMPS total (rolling 24h, post-TDS amounts only) would
//   exceed imps_daily_cap when this transfer is added, the IMPS-tier order
//   falls back to NEFT (per business rule).
//
//   Returns { mode: 'imps'|'neft'|'rtgs', reason, snapshot }
async function chooseTransferMode(amountINR) {
  const limits      = await botStatusService.getPaymentLimits();
  const impsUsed24h = await orderDbService.getImpsAmountLast24h();

  let mode;
  let reason;
  if (amountINR < limits.impsMaxAmount) {
    // IMPS tier — but only if today's IMPS quota has room
    if (impsUsed24h + amountINR <= limits.impsDailyCap) {
      mode   = 'imps';
      reason = 'amount_below_imps_max';
    } else {
      mode   = 'neft';
      reason = 'imps_daily_cap_exhausted';
    }
  } else if (amountINR < limits.neftMaxAmount) {
    mode   = 'neft';
    reason = 'amount_in_neft_band';
  } else {
    mode   = 'rtgs';
    reason = 'amount_above_neft_max';
  }

  return {
    mode,
    reason,
    snapshot: {
      amountINR,
      impsMaxAmount: limits.impsMaxAmount,
      neftMaxAmount: limits.neftMaxAmount,
      impsDailyCap:  limits.impsDailyCap,
      impsUsedToday: impsUsed24h,
      impsRemainingToday: Math.max(0, limits.impsDailyCap - impsUsed24h),
    },
  };
}

async function processPayment(payDetails, amountINR, orderNo) {
  // Gate 1 — credentials present?
  if (!config.features.autoPayment) {
    logger.info('Auto payment skipped — no Cashfree credentials', {
      orderNo, amountINR,
    });
    return manual('no_credentials', amountINR, payDetails);
  }

  // Gate 2 — UI auto_payout toggle ON?
  let autoPayoutEnabled = false;
  try {
    autoPayoutEnabled = await botStatusService.isAutoPayoutEnabled();
  } catch (_) { /* default to OFF on DB hiccup — safer */ }
  if (!autoPayoutEnabled) {
    logger.info('Auto payment skipped — auto_payout toggle is OFF', {
      orderNo, amountINR,
    });
    return manual('toggle_off', amountINR, payDetails);
  }

  // No upper-amount cap. Per business rule:
  //   • amount  <  imps_max_amount           → IMPS
  //   • amount  ∈  [imps_max, neft_max)      → NEFT
  //   • amount  ≥  neft_max                  → RTGS (handles any size)
  //
  // RTGS clears any amount Cashfree will accept, so falling back to manual
  // just because the amount is "large" is wrong. chooseTransferMode() below
  // picks the right method; Cashfree itself rejects only if the bank
  // returns an error (handled in the post-poll catch).
  if (!(amountINR > 0)) {
    throw new Error(`Invalid amount: ${amountINR}`);
  }

  // Gate 4 — Cashfree wallet payouts cannot use UPI (platform-wide). If the
  // seller only gave us a UPI ID with no bank info, fall back to manual.
  const hasBank = !!(payDetails.accountNo && payDetails.ifscCode);
  if (!hasBank) {
    logger.warn('No bank account — Cashfree wallet cannot pay UPI; falling back to manual', {
      orderNo,
      upi:     payDetails.upiId || '(none)',
      method:  payDetails.methodName,
    });
    return manual('upi_only', amountINR, payDetails);
  }

  // Gate 5 — Cashfree requires beneficiary_name to be alphabets/spaces only.
  const safeName = String(payDetails.accountName || 'Seller')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!safeName) {
    logger.warn('Account-holder name unusable for Cashfree — manual', { orderNo });
    return manual('bad_name', amountINR, payDetails);
  }

  // Gate 6 — IFSC format check (Cashfree rejects non-matching strings with
  // a useless error; bail early with a clearer manual fallback).
  const ifscNorm = String(payDetails.ifscCode || '').trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscNorm)) {
    logger.warn('IFSC code malformed — Cashfree would reject; falling back to manual', {
      orderNo, ifsc: ifscNorm,
    });
    return manual('bad_ifsc', amountINR, payDetails);
  }

  // Gate 7 — account number format check
  const accountNorm = String(payDetails.accountNo || '').trim();
  if (!/^[A-Za-z0-9]{4,25}$/.test(accountNorm)) {
    logger.warn('Bank account number malformed — manual', {
      orderNo, accountNo: accountNorm,
    });
    return manual('bad_account', amountINR, payDetails);
  }

  // ── Beneficiary ──────────────────────────────────────────────────────────
  const beneficiary_id = deterministicBeneficiaryId({
    accountNumber: accountNorm,
    ifsc:          ifscNorm,
  });
  const transfer_id = deterministicTransferId(orderNo);

  logger.info('Cashfree payout starting', {
    orderNo,
    amountINR,
    transfer_id,
    beneficiary_id,
    env: config.cashfree.env,
  });

  const beneResp = await createBeneficiary({
    beneficiary_id,
    beneficiary_name: safeName,
    beneficiary_instrument_details: {
      bank_account_number: accountNorm,
      bank_ifsc:           ifscNorm,
    },
  });

  let effectiveBeneficiaryId = beneficiary_id;
  const created       = beneResp.status === 201;
  const sameIdExists  = beneResp.status === 409 &&
                        beneResp.body?.code === 'beneficiary_id_already_exists';
  const accountMapped = beneResp.status === 409 &&
                        beneResp.body?.code === 'conflict_with_existing_beneficiary';

  if (created || sameIdExists) {
    // happy path — our deterministic id is the right one to use
  } else if (accountMapped) {
    // Old random beneficiary already registered for this account. Look it up.
    const existingId = await lookupBeneByAccount({
      accountNumber: accountNorm,
      ifsc:          ifscNorm,
    });
    if (!existingId) {
      throw new Error(
        'Cashfree beneficiary conflict but V1 lookup failed — operator must clear the stale beneficiary from the Cashfree dashboard (Payouts → Beneficiaries) and retry.'
      );
    }
    effectiveBeneficiaryId = existingId;
    logger.warn('Cashfree beneficiary conflict — using existing legacy id', {
      orderNo, legacyBeneficiaryId: existingId,
    });
  } else {
    const code = beneResp.body?.code || 'unknown';
    const msg  = beneResp.body?.message || beneResp.error || 'create beneficiary failed';
    throw new Error(`Cashfree createBeneficiary failed [${code}]: ${msg}`);
  }

  // ── Initiate transfer ────────────────────────────────────────────────────
  // transfer_remarks is omitted intentionally — not needed for our use case.
  // transfer_mode is decided dynamically per amount + dashboard limits +
  // rolling 24h IMPS daily usage. See chooseTransferMode() above.
  const modeDecision = await chooseTransferMode(amountINR);
  logger.info('Transfer mode chosen', {
    orderNo,
    chosenMode: modeDecision.mode,
    reason:     modeDecision.reason,
    ...modeDecision.snapshot,
  });

  // transfer_remarks carries the Binance order number so the payout is
  // traceable back to its order from the Cashfree dashboard / statements.
  // Cashfree restricts remarks to alphanumerics, spaces and a few symbols
  // and caps length, so sanitise + truncate.
  const transferRemarks = `Order ${String(orderNo)}`
    .replace(/[^A-Za-z0-9 ]/g, '')
    .slice(0, 70);

  const transferPayload = {
    transfer_id,
    transfer_amount:   Number(amountINR),
    transfer_currency: 'INR',
    transfer_mode:     modeDecision.mode,
    transfer_remarks:  transferRemarks,
    beneficiary_details: { beneficiary_id: effectiveBeneficiaryId },
    ...(config.cashfree.defaultFundsourceId
      ? { fundsource_id: config.cashfree.defaultFundsourceId }
      : {}),
  };

  const xferResp = await initiateTransfer(transferPayload);
  const duplicateTransfer = !xferResp.ok &&
                            xferResp.body?.code === 'transfer_id_already_exists';

  if (!xferResp.ok && !duplicateTransfer) {
    const code = xferResp.body?.code || 'unknown';
    const msg  = xferResp.body?.message || xferResp.error || 'transfer failed';
    throw new Error(`Cashfree initiateTransfer failed [${code}]: ${msg}`);
  }

  // Persist transfer_id immediately so the webhook receiver can look up
  // this order even if Cashfree's bank-confirmation webhook fires before
  // our polling loop finishes. Fire-and-forget — DB hiccup must not block
  // the payment flow.
  orderDbService.updateOrder(orderNo, { payout_id: transfer_id });

  // ── Poll for terminal status / UTR ───────────────────────────────────────
  // IMPS via Cashfree wallet typically settles in 5–90 sec. Up to ~75 sec
  // of polling here so we can return the UTR if it lands quickly.
  const TERMINAL = new Set([
    'SUCCESS', 'COMPLETED',
    'FAILED', 'REJECTED', 'MANUALLY_REJECTED', 'REVERSED',
  ]);
  const DELAYS_MS = [1500, 1500, 2000, 2000, 3000, 3000, 4000, 5000, 5000, 6000, 6000, 8000, 8000, 10000, 10000];

  let last = duplicateTransfer ? {} : (xferResp.body || {});
  // If we got a duplicate, do an immediate status poll to pick up whatever
  // state Cashfree has for our deterministic transfer_id.
  if (duplicateTransfer) {
    const first = await getTransferStatus(transfer_id);
    if (first.body) last = first.body;
  }

  for (const wait of DELAYS_MS) {
    if (TERMINAL.has(String(last.status || '').toUpperCase()) || last.transfer_utr) break;
    await new Promise(r => setTimeout(r, wait));
    const poll = await getTransferStatus(transfer_id);
    if (poll.body) last = poll.body;
  }

  const finalStatus = String(last.status || '').toUpperCase();
  if (['FAILED', 'REJECTED', 'MANUALLY_REJECTED'].includes(finalStatus)) {
    throw new Error(
      `Cashfree transfer ${finalStatus}: ${last.failure_reason || last.message || 'unknown'}`
    );
  }
  if (finalStatus === 'REVERSED') {
    throw new Error('Cashfree transfer REVERSED — bank reversed the credit');
  }

  const isTerminalSuccess = (finalStatus === 'SUCCESS' || finalStatus === 'COMPLETED')
                            || !!last.transfer_utr;

  logger.info('Cashfree payout poll completed', {
    orderNo,
    transfer_id,
    cf_transfer_id: last.cf_transfer_id || null,
    status:         finalStatus || 'PENDING',
    utr:            last.transfer_utr || '(no UTR yet)',
    amount:         formatINR(amountINR),
    pending:        !isTerminalSuccess,
  });

  if (isTerminalSuccess) {
    // Immediate-success path — the caller marks paid + sends PAYMENT_SENT
    // template with the real UTR. No webhook follow-up needed for the chat.
    return {
      payoutId: last.cf_transfer_id ? String(last.cf_transfer_id) : transfer_id,
      status:   finalStatus || 'SUCCESS',
      mode:     modeDecision.mode.toUpperCase(),   // IMPS / NEFT / RTGS
      amount:   amountINR,
      utr:      last.transfer_utr,
      pending:  false,
    };
  }

  // ── Pending path ──────────────────────────────────────────────────────────
  // Cashfree accepted the transfer but the partner bank hasn't confirmed
  // settlement within the 75-sec poll window. We DO NOT fake a UTR or treat
  // this as success. The caller should:
  //   1. markOrderAsPaid on Binance (so Binance doesn't auto-cancel us)
  //   2. Send the "payment is processing — please wait" template
  //   3. Park the order in WAITING_FOR_RELEASE with paymentPending: true
  //   4. Let Cashfree's webhook (cashfreeWebhookController) drive the final
  //      transition: SUCCESS → send real UTR + PAYMENT_SENT template;
  //      FAILED  → cancel order on Binance + PAYMENT_FAILED template.
  return {
    payoutId:   transfer_id,            // our deterministic id; cf id arrives via webhook
    transferId: transfer_id,
    status:     'PENDING',
    mode:       modeDecision.mode.toUpperCase(),
    amount:     amountINR,
    utr:        null,
    pending:    true,
  };
}

module.exports = { processPayment };
