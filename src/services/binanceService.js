const axios  = require('axios');
const { config }                      = require('../config/config');
const { buildSignedQuery, withRetry } = require('../utils/helpers');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Binance SAPI v7.4 — Official C2C Endpoints
//  POST endpoints: signature in query string, body is JSON
//  GET  endpoints: signature in query string
// ─────────────────────────────────────────────────────────────────────────────

function headers(extra = {}) {
  return {
    'X-MBX-APIKEY': config.binance.apiKey,
    'Content-Type': 'application/json',
    'clientType':   'PC',
    ...extra,
  };
}

function url(endpoint) {
  return `${config.binance.baseUrl}${endpoint}`;
}

// ─── Order Status Codes (per SAPI v7.4) ──────────────────────────────────────
//   1 = Wait for payment   (buyer hasn't paid yet — bot picks these up)
//   2 = Wait for release   (buyer paid, seller needs to release)
//   3 = Appealing
//   4 = Completed
//   6 = Cancelled by user
//   7 = Cancelled by system
const ORDER_STATUS = {
  WAIT_PAYMENT: 1,
  WAIT_RELEASE: 2,
  APPEALING:    3,
  COMPLETED:    4,
  CANCELLED:    6,
  SYS_CANCELLED: 7,
};

// ─── 1. List active orders where bot is the BUYER (Req #1) ───────────────────
async function getPendingOrders() {
  return withRetry(async () => {
    const qs  = buildSignedQuery({});
    const res = await axios.post(
      `${url(config.binance.endpoints.listOrders)}?${qs}`,
      {
        orderStatusList: [ORDER_STATUS.WAIT_PAYMENT, ORDER_STATUS.WAIT_RELEASE],
        tradeType:       'BUY',   // Bot is buyer — picks orders on bot's BUY ad
        page:            1,
        rows:            20,
      },
      { headers: headers(), timeout: 12000 }
    );

    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
    // Defensive: ensure tradeType is BUY only (we are the buyer)
    return list.filter(o => !o.tradeType || String(o.tradeType).toUpperCase() === 'BUY');
  }, 3, 3000, 'getPendingOrders');
}

// ─── 1b. Generic list-by-status helper ───────────────────────────────────────
//   Single page of orders matching any subset of order status codes
//   (1 = wait payment, 2 = wait release, 3 = appealing, 4 = completed,
//   6 = cancelled by user, 7 = cancelled by system). Use for backfill /
//   completion reconciliation.
async function getOrdersByStatus(
  statuses,
  { page = 1, rows = 50, tradeType = 'BUY', sinceDays = 90 } = {}
) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    statuses = [
      ORDER_STATUS.WAIT_PAYMENT,
      ORDER_STATUS.WAIT_RELEASE,
      ORDER_STATUS.APPEALING,
      ORDER_STATUS.COMPLETED,
      ORDER_STATUS.CANCELLED,
      ORDER_STATUS.SYS_CANCELLED,
    ];
  }
  // Rolling lookback window — default last 90 days (~3 months). Stops
  // listOrders from returning years of historical CANCELLED orders that
  // would otherwise bloat the DB. Callers can override sinceDays (or pass
  // 0 / Infinity to disable the filter for a one-off full backfill).
  const startTimestamp = (sinceDays && Number.isFinite(sinceDays))
    ? Date.now() - (Number(sinceDays) * 86_400_000)
    : null;
  return withRetry(async () => {
    const qs = buildSignedQuery({});
    const body = {
      orderStatusList: statuses.map(Number),
      tradeType,
      page,
      rows,
      ...(startTimestamp ? { startTimestamp, endTimestamp: Date.now() } : {}),
    };
    const res = await axios.post(
      `${url(config.binance.endpoints.listOrders)}?${qs}`,
      body,
      { headers: headers(), timeout: 15000 }
    );
    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
    return list;
  }, 2, 3000, `getOrdersByStatus:${statuses.join(',')}:${page}`);
}

// ─── 2. Get full order detail + seller payment methods ───────────────────────
async function getOrderDetail(orderNo) {
  return withRetry(async () => {
    const qs  = buildSignedQuery({});
    const res = await axios.post(
      `${url(config.binance.endpoints.orderDetail)}?${qs}`,
      { adOrderNo: orderNo },
      { headers: headers(), timeout: 12000 }
    );

    const d = res.data?.data || res.data;
    if (!d || (!d.orderNumber && !d.orderNo)) {
      throw new Error(`Empty order detail for ${orderNo}`);
    }
    return d;
  }, 3, 3000, `getOrderDetail:${orderNo}`);
}

// ─── 3. Retrieve Chat WSS Credentials ────────────────────────────────────────
//   Per "How to handle C2C-messages and image v7.4":
//   GET /sapi/v1/c2c/chat/retrieveChatCredential?orderNo=...&clientType=web
//   → { chatWssUrl, listenKey, listenToken }
async function getChatCredential(orderNo) {
  return withRetry(async () => {
    // orderNo NOT required by this endpoint — listenKey is per-USER, not per-order.
    // Pass empty params + clientType=WEB header (verified working in production).
    const qs  = buildSignedQuery({});
    const res = await axios.get(
      `${url(config.binance.endpoints.chatCredential)}?${qs}`,
      { headers: headers({ clientType: 'WEB' }), timeout: 12000 }
    );

    const d = res.data?.data || res.data;
    if (!d?.listenKey || !d?.listenToken) {
      throw new Error(`Invalid chat credential for order ${orderNo}`);
    }

    logger.info('Chat credential received', {
      orderNo,
      hasWssUrl:    !!d.chatWssUrl,
      listenKeyLen: d.listenKey.length,
    });

    return d; // { chatWssUrl?, listenKey, listenToken }
  }, 3, 3000, `getChatCredential:${orderNo}`);
}

// ─── 4. Retrieve Chat Messages (fallback polling) ────────────────────────────
async function getChatMessages(orderNo, lastMsgId = null) {
  return withRetry(async () => {
    const params = { orderNo, page: 1, rows: 50, clientType: 'web' };
    if (lastMsgId) params.lastMsgId = lastMsgId;

    const qs  = buildSignedQuery(params);
    const res = await axios.get(
      `${url(config.binance.endpoints.chatMessages)}?${qs}`,
      { headers: headers(), timeout: 12000 }
    );

    const d = res.data?.data || res.data;
    return Array.isArray(d) ? d : (d?.messageList || d?.list || []);
  }, 3, 2000, `getChatMessages:${orderNo}`);
}

// ─── 5. Mark messages as read ────────────────────────────────────────────────
async function markMessagesRead(orderNo) {
  try {
    const qs = buildSignedQuery({});
    await axios.post(
      `${url(config.binance.endpoints.markMsgRead)}?${qs}`,
      { orderNo },
      { headers: headers(), timeout: 8000 }
    );
  } catch (err) {
    logger.warn('markMessagesRead failed (non-critical)', { orderNo, error: err.message });
  }
}

// ─── 6. Mark order as paid (buyer side) ──────────────────────────────────────
//   Triggers Binance's own system message on the chat — something like
//   "<bot-nickname> (real name: <kyc>) has marked the order as paid. Please
//   verify the payment in your account before releasing the asset."
//   Calling this is what turns the order from status 1 (Wait for Payment) to
//   status 2 (Wait for Release) on Binance's side.
//
//   Optional payInfo carries the UTR / bank reference so it's visible to the
//   seller on Binance's own UI as the buyer's payment proof. v7.4 accepts it
//   as a free-form string; if Binance ignores it the call still succeeds.
async function markOrderAsPaid(orderNo, payId, utr) {
  return withRetry(async () => {
    const qs   = buildSignedQuery({});
    const body = { orderNumber: orderNo };
    if (payId) body.payId   = payId;
    if (utr)   body.payInfo = `UTR: ${String(utr).slice(0, 60)}`;
    const res = await axios.post(
      `${url(config.binance.endpoints.markPaid)}?${qs}`,
      body,
      { headers: headers(), timeout: 12000 }
    );

    logger.info('Order marked as paid on Binance', {
      orderNo, payId, utr: utr || null,
    });
    return res.data;
  }, 3, 3000, `markOrderAsPaid:${orderNo}`);
}

// ─── Cancel reason code enum (per SAPI v7.4 spec) ────────────────────────────
const CANCEL_REASON = {
  CHANGE_MIND:                 1, // "I change mind"
  DONT_MEET_SELLER_REQUIREMENT: 2, // "I don't meet seller's requirement"
  SELLER_EXTRA_FEE:            3, // "Seller asking extra fee"
  SELLER_PAY_METHOD_ISSUE:     4, // "Seller's payment method issue"
  OTHER:                       5, // "Other" (use additionalInfo to describe)
  SELLER_CANNOT_RELEASE:       6, // "Seller cannot release"
};

// ─── Seller-fault cancel reasons (used by auto-cancel) ───────────────────────
//   Only codes 3/4/6 attribute the cancellation to the seller's side, so the
//   bot's cancellation rate is NOT impacted. The bot rotates randomly through
//   these reasons so the seller sees a varied (more human-looking) reason
//   each time instead of the same one every cancel.
const SELLER_CANCEL_REASONS = [
  {
    code: CANCEL_REASON.SELLER_PAY_METHOD_ISSUE,            // 4
    info: "Problem with seller's payment method result in unsuccessful payments",
  },
  {
    code: CANCEL_REASON.SELLER_CANNOT_RELEASE,              // 6
    info: "Seller cannot release the order due to network issue. The seller has refunded the amount.",
  },
  {
    code: CANCEL_REASON.SELLER_CANNOT_RELEASE,              // 6
    info: "No response from the seller",
  },
];

// Pick a random seller-fault cancel reason. Returns { code, info }.
function pickSellerCancelReason() {
  const idx = Math.floor(Math.random() * SELLER_CANCEL_REASONS.length);
  return SELLER_CANCEL_REASONS[idx];
}

// ─── Pre-check: is buyer allowed to cancel this order right now? ─────────────
//   POST /sapi/v1/c2c/orderMatch/checkIfAllowedCancelOrder
//   Returns boolean — false typically when order is past status 1 (already paid)
async function canCancelOrder(orderNo) {
  try {
    const qs  = buildSignedQuery({});
    const res = await axios.post(
      `${url(config.binance.endpoints.canCancel)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 10000 }
    );
    return Boolean(res.data?.data ?? res.data);
  } catch (err) {
    // Don't block cancel attempt if pre-check fails — let real cancel call decide
    logger.warn('canCancelOrder pre-check errored', { orderNo, error: err.message });
    return true;
  }
}

// ─── Cancel an order (buyer side) ────────────────────────────────────────────
//   POST /sapi/v1/c2c/orderMatch/cancelOrder
//   Body fields per v7.4 spec:
//     orderNumber              — string
//     orderCancelReasonCode    — integer (1..6, see CANCEL_REASON)
//     orderCancelAdditionalInfo — string (used when reasonCode === 5/OTHER)
//   Constraints (per Binance):
//     - Only orderStatus === 1 (Wait for payment) is cancellable
//     - After markOrderAsPaid (status 2) → use Appeal, not Cancel
//     - Cancellation rate impacts merchant rating
async function cancelOrder(orderNo, reasonCode = CANCEL_REASON.OTHER, additionalInfo = '') {
  return withRetry(async () => {
    const qs   = buildSignedQuery({});
    const body = {
      orderNumber:               orderNo,
      orderCancelReasonCode:     reasonCode,
      orderCancelAdditionalInfo: additionalInfo || '',
    };
    const res = await axios.post(
      `${url(config.binance.endpoints.cancelOrder)}?${qs}`,
      body,
      { headers: headers(), timeout: 12000 }
    );
    logger.warn('Order cancelled on Binance', {
      orderNo, reasonCode, additionalInfo, response: res.data,
    });
    return res.data;
  }, 2, 3000, `cancelOrder:${orderNo}`);
}

// ─── 7. Send chat message via REST (WSS-send fallback) ───────────────────────
//   Per SAPI v7.4: POST /sapi/v1/c2c/chat/sendMessage
//   Body: { orderNo, content, msgType: 'text' }
async function sendChatMessageREST(orderNo, content) {
  return withRetry(async () => {
    const qs  = buildSignedQuery({});
    const res = await axios.post(
      `${url(config.binance.endpoints.sendMessage)}?${qs}`,
      { orderNo, content, msgType: 'text' },
      { headers: headers(), timeout: 12000 }
    );
    return res.data;
  }, 3, 2000, `sendChatMessageREST:${orderNo}`);
}

// ─── 8. Extract SELLER's payment details from order detail ───────────────────
//   Req #3: After PAN verification, check seller payment details.
//   In a BUY order, payMethods[] in the order detail contains the SELLER's
//   bank/UPI/IMPS info that the buyer (bot) must pay to.
function extractPaymentDetails(orderDetail) {
  const methods = orderDetail.payMethods
    || orderDetail.payMethod
    || orderDetail.tradeMethods
    || [];
  if (!methods.length) {
    throw new Error('No payment methods available on order');
  }

  // Pick the seller's payment method, preferring bank transfer over UPI so
  // the active payout provider can handle it (UPI payouts are not supported
  // by RazorpayX / Paywize bank-payout APIs).
  // Bank-transfer methods include: "Bank Transfer (India)", "IMPS", "IMPS - PAN",
  // "NEFT", "RTGS". UPI is last so it only wins if no bank account is offered.
  //
  // Score reflects auto-payability + speed:
  //   3 — explicit IMPS-tagged bank methods (fastest)
  //   2 — generic bank transfer (IMPS/NEFT/RTGS picked dynamically by amount)
  //   1 — UPI (manual fallback)
  //   0 — anything else
  const score = (m) => {
    const id   = String(m.tradeMethodIdentifier || m.identifier || '').toUpperCase();
    const name = String(m.tradeMethodName || m.tradeMethodShortName || '').toUpperCase();
    const combined = `${id} ${name}`;
    if (/\bIMPS\b/.test(combined))                  return 3;
    if (/\bBANK\b|\bNEFT\b|\bRTGS\b/.test(combined)) return 2;
    if (/\bUPI\b|\bVPA\b/.test(combined))            return 1;
    return 0;
  };
  const ranked = [...methods].sort((a, b) => score(b) - score(a));
  const method = ranked[0];

  const fieldList = method.fieldList || method.fields || [];

  // Robust field lookup that ranks candidates and picks the best one.
  // The old substring-match was matching "Account holder name" when asked
  // for "account number" (because both contain "acc"), so the seller's
  // NAME ended up in the accountNo field and the provider's auto-payment
  // was rejected as bad_account.
  //
  // patterns: ordered list of {regex, score}. Highest scoring field wins.
  // Negative `excludeRe` removes false positives.
  const matchField = (patterns, excludeRe = null) => {
    let best = null;
    let bestScore = -1;
    for (const f of fieldList) {
      const fname = String(f.fieldName || f.name || '').toLowerCase().trim();
      if (!fname) continue;
      if (excludeRe && excludeRe.test(fname)) continue;
      const value = f.fieldValue || f.value;
      if (!value) continue;
      for (const { regex, score } of patterns) {
        if (regex.test(fname) && score > bestScore) {
          best = value;
          bestScore = score;
          break;
        }
      }
    }
    return best;
  };

  // ── Account number — must NOT match "account holder name" or "account name"
  const accountNo = matchField(
    [
      { regex: /^bank\s*account\s*(number|no)\b/, score: 5 },
      { regex: /^account\s*(number|no)\b/,         score: 4 },
      { regex: /\baccount\s*(number|no)\b/,        score: 3 },
      { regex: /\bbank\s*account\b/,               score: 2 },
      { regex: /\bacc(ount)?\s*#?\s*no?\b/,        score: 1 },
    ],
    /name|holder/   // never accept name-like fields
  );

  // ── IFSC — fairly unambiguous, just match the token
  const ifscCode = matchField([
    { regex: /\bifsc\b/, score: 1 },
  ]);

  // ── Bank name — must NOT match "bank account ..."
  const bankName = matchField(
    [
      { regex: /\bbank\s*name\b/,   score: 3 },
      { regex: /^bank\b\s*$/,       score: 2 },
      { regex: /\bbank\b/,          score: 1 },
    ],
    /account|number|ifsc|branch/
  );

  // ── Account-holder name — must NOT match "account number" / "bank name"
  const accountName = matchField(
    [
      { regex: /\b(account\s*)?holder\s*name\b/,    score: 5 },
      { regex: /\bbeneficiary\s*name\b/,            score: 5 },
      { regex: /\baccount\s*name\b/,                score: 4 },
      { regex: /^name\b\s*$/,                       score: 3 },
      { regex: /\bfull\s*name\b/,                   score: 3 },
      { regex: /\bname\b/,                          score: 1 },
    ],
    /number|ifsc|bank\s*name|branch|address/
  );

  // ── UPI / VPA — distinct namespace, simple match
  const upiId = matchField([
    { regex: /\bupi\s*id\b/, score: 3 },
    { regex: /\bvpa\b/,      score: 2 },
    { regex: /\bupi\b/,      score: 1 },
  ]);

  return {
    payId:       method.id || method.payId || method.tradeMethodIdentifier,
    methodName:  method.tradeMethodName || method.tradeMethodShortName || method.name || 'UNKNOWN',
    methodId:    method.tradeMethodIdentifier || method.identifier || '',
    upiId,
    accountNo,
    ifscCode,
    bankName,
    accountName: accountName ||
                 orderDetail.payerNickname ||
                 orderDetail.sellerNickname ||
                 'Seller',
    raw:         fieldList,
    isUPI:       !!upiId && !(accountNo && ifscCode),  // UPI mode only if no bank
  };
}

// ─── 9. List the merchant's own P2P ads (best-effort) ────────────────────────
//   Binance's C2C ads-list endpoint name varies by SAPI doc version. We try
//   the most commonly-deployed path first and fall back to an empty list on
//   error so the /api/ads endpoint stays useful even if Binance's ad-list
//   API is unavailable to this account. Override the path via env
//   BINANCE_MY_ADS_ENDPOINT if your account uses a different one.
async function getMyAds() {
  const endpoint = process.env.BINANCE_MY_ADS_ENDPOINT || '/sapi/v1/c2c/ads/searchAdsByPage';
  try {
    const qs = buildSignedQuery({});
    const res = await axios.post(
      `${config.binance.baseUrl}${endpoint}?${qs}`,
      { page: 1, rows: 50 },
      { headers: headers(), timeout: 12000 }
    );
    const d = res.data?.data || res.data;
    const list = Array.isArray(d) ? d : (d?.advList || d?.list || d?.data || []);
    return list.map((a) => ({
      advNo:               a.advNo || a.advOrderNo || a.id,
      tradeType:           a.tradeType || a.advType,
      asset:               a.asset,
      fiat:                a.fiatUnit || a.fiat,
      price:               a.price,
      minSingleTransAmount: a.minSingleTransAmount || a.minAmount,
      maxSingleTransAmount: a.maxSingleTransAmount || a.maxAmount,
      advStatus:           a.advStatus || a.status,
      raw:                 a,
    }));
  } catch (err) {
    logger.warn('getMyAds failed (endpoint may not be enabled for this account)', {
      endpoint, error: err.response?.data?.msg || err.message,
    });
    return [];
  }
}

// ─── 9b. Update Ad with Eligibility Criteria ─────────────────────────────────
//   POST /sapi/v1/c2c/ads/update - Updates seller ad with new parameters
//   including eligibility criteria (buy/sell trade counts, completion rate, etc)
async function updateAd(advNo, updates = {}) {
  return withRetry(async () => {
    console.log(`\n📡 [BINANCE API] Calling updateAd`);
    console.log(`   Ad No: ${advNo}`);
    console.log(`   Fields to update: ${Object.keys(updates).join(', ')}`);

    const qs = buildSignedQuery({});

    const payload = {
      advNo,
      ...updates,
    };

    console.log(`   Full payload: ${JSON.stringify(payload, null, 2)}`);
    console.log(`   Signature: ${qs.substring(0, 50)}...`);

    logger.info('Updating Binance ad', {
      advNo,
      updateFields: Object.keys(updates),
    });

    console.log(`   Sending POST request to: /sapi/v1/c2c/ads/update`);
    const res = await axios.post(
      `${config.binance.baseUrl}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log(`   ✅ Binance API Response received`);
    console.log(`   Status: ${res.status}`);
    console.log(`   Data: ${JSON.stringify(res.data, null, 2)}`);

    logger.info('Binance ad updated successfully', {
      advNo,
      response: res.data,
    });

    return res.data;
  }, 3, 3000, 'updateAd');
}

// ─── 10. Binance Convert API ─────────────────────────────────────────────────
//   POST /sapi/v1/convert/getQuote        — request a quote (~10 sec validity)
//   POST /sapi/v1/convert/acceptQuote     — execute by quoteId
//   GET  /sapi/v1/convert/orderStatus     — verify the conversion outcome
//
//   All endpoints are signed (SAPI). API key needs "Spot & Margin Trading"
//   OR "Convert" permission enabled in Binance API Management.

// Request a quote for converting `fromAmount` of `fromAsset` → `toAsset`.
// walletType: 'SPOT' (default) or 'FUNDING'. P2P releases land in FUNDING
// for merchant accounts — pass that when the released crypto is in funding.
// Returns { quoteId, ratio, inverseRatio, validTime, toAmount, ... }.
async function getConvertQuote(fromAsset, toAsset, fromAmount, opts = {}) {
  const walletType = String(opts.walletType || 'SPOT').toUpperCase();
  const qs = buildSignedQuery({
    fromAsset,
    toAsset,
    fromAmount: String(fromAmount),
    walletType,
  });
  const res = await axios.post(
    `${url('/sapi/v1/convert/getQuote')}?${qs}`,
    null,
    { headers: headers(), timeout: 12000 }
  );
  return res.data?.data || res.data;
}

// Execute a previously-quoted conversion. Returns { orderId, createTime,
// orderStatus: 'PROCESS' | 'SUCCESS' | ... }.
async function acceptConvertQuote(quoteId) {
  const qs = buildSignedQuery({ quoteId });
  const res = await axios.post(
    `${url('/sapi/v1/convert/acceptQuote')}?${qs}`,
    null,
    { headers: headers(), timeout: 12000 }
  );
  return res.data?.data || res.data;
}

// Fetch the final state of a conversion order — used to confirm SUCCESS
// after acceptQuote (which may return PROCESS initially).
async function getConvertOrderStatus({ orderId, quoteId } = {}) {
  const qs = buildSignedQuery(orderId ? { orderId } : { quoteId });
  const res = await axios.get(
    `${url('/sapi/v1/convert/orderStatus')}?${qs}`,
    { headers: headers(), timeout: 12000 }
  );
  return res.data?.data || res.data;
}

// Read the live spot wallet balance for a single asset.
async function getSpotBalance(asset) {
  const qs = buildSignedQuery({});
  const res = await axios.get(
    `${url('/api/v3/account')}?${qs}`,
    { headers: headers(), timeout: 12000 }
  );
  const balances = res.data?.balances || [];
  const row = balances.find((b) => String(b.asset).toUpperCase() === String(asset).toUpperCase());
  return row ? { free: Number(row.free) || 0, locked: Number(row.locked) || 0 } : { free: 0, locked: 0 };
}

// Read the funding wallet balance for a single asset. P2P releases are
// credited to the FUNDING wallet by default for most merchant accounts,
// not the spot wallet — so post-release auto-convert MUST check here too.
async function getFundingBalance(asset) {
  const qs = buildSignedQuery({ asset: String(asset).toUpperCase() });
  const res = await axios.post(
    `${url('/sapi/v1/asset/get-funding-asset')}?${qs}`,
    null,
    { headers: headers(), timeout: 12000 }
  );
  const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
  const row = list.find((r) => String(r.asset).toUpperCase() === String(asset).toUpperCase());
  return row
    ? { free: Number(row.free) || 0, locked: Number(row.locked) || 0 }
    : { free: 0, locked: 0 };
}

module.exports = {
  ORDER_STATUS,
  CANCEL_REASON,
  SELLER_CANCEL_REASONS,
  pickSellerCancelReason,
  getPendingOrders,
  getOrderDetail,
  getChatCredential,
  getChatMessages,
  markMessagesRead,
  markOrderAsPaid,
  cancelOrder,
  canCancelOrder,
  sendChatMessageREST,
  extractPaymentDetails,
  getMyAds,
  updateAd,
  getOrdersByStatus,
  getConvertQuote,
  acceptConvertQuote,
  getConvertOrderStatus,
  getSpotBalance,
  getFundingBalance,
};
