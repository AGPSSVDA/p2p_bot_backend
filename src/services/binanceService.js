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
async function markOrderAsPaid(orderNo, payId) {
  return withRetry(async () => {
    const qs  = buildSignedQuery({});
    const body = payId ? { orderNumber: orderNo, payId } : { orderNumber: orderNo };
    const res = await axios.post(
      `${url(config.binance.endpoints.markPaid)}?${qs}`,
      body,
      { headers: headers(), timeout: 12000 }
    );

    logger.info('Order marked as paid on Binance', { orderNo, payId });
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

  // Prefer UPI > IMPS > NEFT > others (faster settlement)
  const score = (m) => {
    const id   = (m.tradeMethodIdentifier || m.identifier || '').toUpperCase();
    const name = (m.tradeMethodName || m.tradeMethodShortName || '').toUpperCase();
    if (id.includes('UPI')  || name.includes('UPI'))  return 3;
    if (id.includes('IMPS') || name.includes('IMPS')) return 2;
    if (id.includes('NEFT') || name.includes('NEFT')) return 1;
    return 0;
  };
  const ranked = [...methods].sort((a, b) => score(b) - score(a));
  const method = ranked[0];

  const fieldList = method.fieldList || method.fields || [];

  const getField = (names) => {
    const lower = names.map(n => n.toLowerCase());
    const f = fieldList.find(f =>
      lower.some(n => (f.fieldName || f.name || '').toLowerCase().includes(n))
    );
    return f?.fieldValue || f?.value || null;
  };

  const upiId = getField(['upi id', 'vpa', 'upi']);

  return {
    payId:       method.id || method.payId || method.tradeMethodIdentifier,
    methodName:  method.tradeMethodName || method.tradeMethodShortName || method.name || 'UNKNOWN',
    methodId:    method.tradeMethodIdentifier || method.identifier || '',
    upiId,
    accountNo:   getField(['account number', 'account no', 'acc']),
    ifscCode:    getField(['ifsc']),
    bankName:    getField(['bank name', 'bank']),
    accountName:
      getField(['name', 'account name']) ||
      orderDetail.payerNickname ||
      orderDetail.sellerNickname ||
      'Seller',
    raw:         fieldList,
    isUPI:       !!upiId,
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

module.exports = {
  ORDER_STATUS,
  CANCEL_REASON,
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
};
