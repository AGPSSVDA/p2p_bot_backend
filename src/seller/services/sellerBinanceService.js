/**
 * Seller-specific Binance Service
 * Uses separate API keys and config for seller operations
 * Keeps buyer and seller accounts isolated
 */

const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const sellerBinanceConfig = require('../../config/sellerBinanceConfig');
const { withRetry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Force IPv4 for all Binance calls. Binance API-key IP whitelists are IPv4, but
// on dual-stack networks Node may connect over IPv6, which Binance then rejects
// with -2015 "Invalid API-key, IP, or permissions". family:4 pins it to IPv4.
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

// Seller-specific headers with seller API key
function headers(extra = {}) {
  return {
    'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
    'Content-Type': 'application/json',
    'clientType': 'PC',
    ...extra,
  };
}

function url(endpoint) {
  return `${sellerBinanceConfig.baseUrl}${endpoint}`;
}

// Seller-specific signature using seller secret key
function signQuery(queryString) {
  return crypto
    .createHmac('sha256', sellerBinanceConfig.secretKey)
    .update(queryString)
    .digest('hex');
}

// Seller-specific query builder with seller secret key
function buildSignedQuery(params = {}) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryStr = Object.entries(allParams)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = signQuery(queryStr);
  return `${queryStr}&signature=${signature}`;
}

// Order status codes
const ORDER_STATUS = {
  WAIT_PAYMENT: 1,
  WAIT_RELEASE: 2,
  APPEALING: 3,
  COMPLETED: 4,
  CANCELLED: 6,
  SYS_CANCELLED: 7,
};

/**
 * Get Pending Sell Orders (Orders on seller's ads)
 * Fetch orders where seller is receiving payment from buyers
 * Endpoint: POST /sapi/v1/c2c/orderMatch/listOrders
 */
async function getPendingSellOrders() {
  return withRetry(async () => {
    const qs = buildSignedQuery({});
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.listOrders)}?${qs}`,
      {
        orderStatusList: [ORDER_STATUS.WAIT_PAYMENT, ORDER_STATUS.WAIT_RELEASE],
        tradeType: 'SELL',  // Seller receiving buy orders
        page: 1,
        rows: 20,
      },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
    return list.filter(o => !o.tradeType || String(o.tradeType).toUpperCase() === 'SELL');
  }, 3, 3000, 'getPendingSellOrders');
}

/**
 * Get Counter Party Order Statistics (Buyer's metrics)
 * Fetch buyer's trading history and statistics
 * Endpoint: POST /sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic
 */
async function getCounterPartyOrderStats(orderNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });

    console.log(`\n[BinanceService] 🔗 queryCounterPartyOrderStatistic API Call:`);
    console.log(`   Order No: ${orderNo}`);
    console.log(`   URL: ${url(sellerBinanceConfig.endpoints.queryCounterPartyOrderStatistic)}`);
    console.log(`   Query String: ${qs}`);
    console.log(`   API Key: ${sellerBinanceConfig.apiKey?.substring(0, 10)}...`);

    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.queryCounterPartyOrderStatistic)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    console.log(`   Status: ${res.status}`);
    console.log(`   Full Response:`, JSON.stringify(res.data, null, 2));

    const data = res.data?.data || res.data;

    // Map Binance response fields to our format
    // Binance returns different field names, map them correctly
    const result = {
      // 30-day metrics
      trades_30day: data?.completedOrderNumOfLatest30day || data?.completedOrderNum || 0,
      completion_rate_30day: (parseFloat(data?.finishRateLatest30Day) || parseFloat(data?.finishRate) || 0) * 100,  // Convert to percentage
      registered_days: data?.registerDays || 0,

      // Overall metrics
      all_trades_count: data?.completedOrderNum || 0,
      buy_orders_count: 0,  // Not directly provided by Binance
      sell_orders_count: 0,  // Not directly provided by Binance
      trading_counterparty_count: data?.numberOfTradesWithCounterpartyCompleted30day || 0,

      // Time metrics (Binance returns in milliseconds, convert to minutes)
      avg_release_time_minutes: Math.round((data?.avgReleaseTimeOfLatest30day || 0) / 60000),
      avg_pay_time_minutes: Math.round((data?.avgPayTimeOfLatest30day || 0) / 60000),

      // Store raw for reference
      raw_binance_response: data
    };

    console.log(`   Parsed Result:`, JSON.stringify(result, null, 2));
    console.log();

    return result;
  }, 3, 3000, `getCounterPartyOrderStats:${orderNo}`);
}

/**
 * Get User Details (Buyer info)
 * Fetch buyer's profile information
 * Endpoint: GET /sapi/v1/c2c/user/queryUser
 */
async function getUserDetails(userId) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ userId });
    const res = await axios.get(
      `${url(sellerBinanceConfig.endpoints.queryUser)}?${qs}`,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    const data = res.data?.data || res.data;
    return {
      id: data?.id,
      name: data?.name,
      email: data?.email,
      mobile: data?.mobile
    };
  }, 3, 3000, `getUserDetails:${userId}`);
}

/**
 * Get the seller's own UPI details (UPI ID + payee name) from their configured
 * payment methods. Used for the Express UPI flow: Binance leaves the Express UPI
 * QR field empty (can't be set via API), so we build a UPI QR from the seller's
 * real UPI ID (which IS filled on their normal UPI method) and show it to the buyer.
 * Endpoint: GET /sapi/v1/c2c/paymentMethod/getPayMethodByUserId
 * @returns {Promise<{upiId:string|null, payeeName:string|null}>}
 */
async function getSellerUpiDetails() {
  return withRetry(async () => {
    const qs = buildSignedQuery({});
    const res = await axios.get(
      `${url('/sapi/v1/c2c/paymentMethod/getPayMethodByUserId')}?${qs}`,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const methods = res.data?.data || [];
    // Prefer a plain UPI method that has a pay_account (UPI ID) filled in.
    for (const m of methods) {
      const ident = (m.tradeMethodIdentifier || m.tradeMethod?.identifier || '').toLowerCase();
      // Skip the Express UPI method itself (its fields are empty) and take a normal UPI.
      if (ident.includes('p2plus') || ident.includes('express')) continue;
      const fields = m.fieldList || [];
      const acct = fields.find(f => f.fieldContentType === 'pay_account' && f.fieldValue);
      if (acct && /^[\w.\-]+@[\w.\-]+$/.test(String(acct.fieldValue).trim())) {
        const payee = fields.find(f => f.fieldContentType === 'payee' && f.fieldValue);
        return { upiId: String(acct.fieldValue).trim(), payeeName: payee?.fieldValue || null };
      }
    }
    return { upiId: null, payeeName: null };
  }, 3, 3000, 'getSellerUpiDetails');
}

/**
 * Verify Additional KYC — confirms the order on Binance's side.
 * Endpoint: POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc
 *
 * IMPORTANT: This is an ACTION (it verifies/confirms the order), NOT a status poll.
 * Only call it AFTER liveness completion has been confirmed via the chat signal
 * (see checkLivenessViaChat). Calling it earlier would verify the order before the
 * buyer actually completed liveness.
 */
async function verifyAdditionalKyc(orderNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.verifiedAdditionalKyc)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    const responseData = res.data?.data || res.data || {};
    const kycVerified = responseData.kycVerified === true;
    const success = res.data?.code === '000000' || res.data?.code === 0 || res.status === 200;

    return {
      success,
      kycVerified,
      code: res.data?.code,
      message: res.data?.message || 'Verification requested',
      orderNumber: responseData.orderNumber || orderNo,
      raw: responseData
    };
  }, 3, 3000, `verifyAdditionalKyc:${orderNo}`);
}

/**
 * Method 3: Check whether the seller can release the crypto for an order yet.
 * Endpoint: POST /sapi/v1/c2c/orderMatch/checkIfCanReleaseCoin  → boolean
 */
async function checkIfCanReleaseCoin(orderNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.checkCanRelease)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const data = res.data?.data;
    const canRelease = data === true || data === 'true' ||
      res.data?.code === '000000' || res.data?.code === 0;
    return { success: true, canRelease, code: res.data?.code, message: res.data?.message, raw: res.data };
  }, 3, 3000, `checkIfCanReleaseCoin:${orderNo}`);
}

/**
 * Fetch Binance's RSA public key used to encrypt the fund password.
 * Endpoint: GET /sapi/v1/c2c/cryptography/rsa-public-key → { data: "<base64 SPKI>" }
 * (per Binance support's auto-release doc, PDF 1, Step 1.)
 */
async function getRsaPublicKey() {
  return withRetry(async () => {
    const qs = buildSignedQuery({});
    const res = await axios.get(
      `${url(sellerBinanceConfig.endpoints.rsaPublicKey)}?${qs}`,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const key = res.data?.data;
    if (!key) throw new Error(`rsa-public-key: no key in response (code ${res.data?.code})`);
    return key;
  }, 3, 3000, 'getRsaPublicKey');
}

/**
 * Encrypt the fund password with Binance's RSA public key.
 * The doc specifies Java "RSA/ECB/OAEPWITHSHA-256ANDMGF1PADDING" — the Node
 * equivalent is RSA_PKCS1_OAEP_PADDING with oaepHash 'sha256' (MGF1 defaults to the
 * same hash). Verified round-trip locally. `publicKeyBase64` is the base64 SPKI
 * (DER) string returned by getRsaPublicKey().
 */
function encryptFundPassword(fundPassword, publicKeyBase64) {
  const keyObj = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.publicEncrypt(
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(fundPassword), 'utf-8')
  ).toString('base64');
}

/**
 * Method 3: Release the crypto to the buyer using the FUND PASSWORD method
 * (Binance support's auto-release doc, PDF 1).
 *
 * Flow: fetch the RSA public key → RSA-OAEP-SHA256 encrypt the fund password →
 * POST releaseCoin with { authType:'FUND_PWD', code:<encrypted>, orderNumber,
 * payId, confirmPaidType }.
 *   confirmPaidType 'normal' → order status 2 (buyer already paid)  ← our case
 *   confirmPaidType 'quick'  → order status 1 (pending buyer payment)
 *
 * The fund password comes from env SELLER_FUND_PASSWORD; it is only ever held in
 * memory, RSA-encrypted per call, and NEVER logged. If it isn't set, we skip the
 * code (works only if the account needs no auth) so the caller can fall back to
 * manual release. `payId` and `confirmPaidType` are passed by the caller.
 *
 * @param {string} orderNo
 * @param {object} [opts] { payId, confirmPaidType }
 */
async function releaseCoin(orderNo, opts = {}) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });
    const body = { orderNumber: orderNo };
    if (opts.payId != null) body.payId = opts.payId;
    body.confirmPaidType = opts.confirmPaidType || 'normal';

    // FUND_PWD auto-release: encrypt the fund password with Binance's RSA key.
    const fundPassword = process.env.SELLER_FUND_PASSWORD;
    if (fundPassword) {
      try {
        const pubKey = await getRsaPublicKey();
        body.authType = 'FUND_PWD';
        body.code = encryptFundPassword(fundPassword, pubKey);
      } catch (keyErr) {
        logger.error(`[${orderNo}] Fund-password encryption failed: ${keyErr.message}`);
        // Fall through without a code — Binance will reject if auth is required,
        // and the caller then routes to manual release.
      }
    } else if (process.env.SELLER_RELEASE_AUTH_TYPE) {
      // Legacy fallback (e.g. an account still on a static auth type).
      body.authType = process.env.SELLER_RELEASE_AUTH_TYPE;
      if (process.env.SELLER_RELEASE_GOOGLE_CODE) body.googleVerifyCode = process.env.SELLER_RELEASE_GOOGLE_CODE;
      if (process.env.SELLER_RELEASE_MOBILE_CODE) body.mobileVerifyCode = process.env.SELLER_RELEASE_MOBILE_CODE;
      if (process.env.SELLER_RELEASE_EMAIL_CODE) body.emailVerifyCode = process.env.SELLER_RELEASE_EMAIL_CODE;
    }

    // Never log the encrypted code or the password.
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.releaseCoin)}?${qs}`,
      body,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const success = res.data?.code === '000000' || res.data?.code === 0 || res.status === 200;
    return { success, code: res.data?.code, message: res.data?.message || res.data?.msg || 'release requested', raw: res.data };
    // retries=1: a release must NEVER re-send the fund password. A wrong password
    // is aborted by withRetry's 83895/83896 guard anyway; this is belt-and-braces.
  }, 1, 3000, `releaseCoin:${orderNo}`);
}

/**
 * Method 3 auto-release via the EXPRESS-UPI / Lightning endpoint.
 * Endpoint: POST /sapi/v1/c2c/orderMatch/releaseOrder
 *
 * Per Binance support's Express-UPI reply, this needs NO fund password and NO 2FA
 * — just a standard signed request with the order number. This is the preferred
 * auto-release path for Express-UPI-enabled (whitelisted) merchant accounts.
 *
 * The orderNo goes in the signed query (like our other signed POSTs); the body
 * carries orderNo too. Signature/timestamp are handled by buildSignedQuery. On any
 * failure we surface code+message so the caller can fall back to manual release.
 */
async function releaseOrder(orderNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.releaseOrder)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const success = res.data?.code === '000000' || res.data?.code === 0 || res.status === 200;
    return { success, code: res.data?.code, message: res.data?.message || res.data?.msg || 'release requested', raw: res.data };
  }, 1, 3000, `releaseOrder:${orderNo}`);
}

/**
 * Get Order Detail (Full order information including buyer's real KYC name).
 * Endpoint: POST /sapi/v1/c2c/orderMatch/getUserOrderDetail
 *
 * NOTE: Binance is INCONSISTENT about the param name for this endpoint — some
 * orders accept `orderNumber`, others require `adOrderNo` (both equal the order
 * number for our SELL orders). Passing the wrong one returns 400 -31002
 * "illegal parameter". So we try `orderNumber` first, then fall back to
 * `adOrderNo`. This is what makes buyerName (KYC name) reliably available.
 */
async function getOrderDetail(orderNumber) {
  return withRetry(async () => {
    let res;
    try {
      const qs = buildSignedQuery({ orderNumber });
      res = await axios.post(
        `${url(sellerBinanceConfig.endpoints.orderDetail)}?${qs}`,
        { orderNumber },
        { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
      );
    } catch (err) {
      if (err.response?.data?.code === -31002) {
        // Fall back to the adOrderNo param (same value, different key).
        const qs2 = buildSignedQuery({ adOrderNo: orderNumber });
        res = await axios.post(
          `${url(sellerBinanceConfig.endpoints.orderDetail)}?${qs2}`,
          { adOrderNo: orderNumber },
          { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
        );
      } else {
        throw err;
      }
    }

    const data = res.data?.data || res.data;
    return {
      orderNumber: data?.orderNumber,
      advOrderNumber: data?.advOrderNumber,
      buyerNickname: data?.buyerNickname,
      buyerName: data?.buyerName,
      takerUserNo: data?.takerUserNo,
      totalPrice: data?.totalPrice,
      fiatUnit: data?.fiatUnit,
      asset: data?.asset,
      amount: data?.amount,
      tradeType: data?.tradeType,
      orderStatus: data?.orderStatus,
      // Additional-KYC ("liveness") status: 0=not required, 1=pending, 2=verified
      additionalKycVerify: data?.additionalKycVerify,
      // Store full response for debugging
      raw: data
    };
  }, 3, 3000, `getOrderDetail:${orderNumber}`);
}

/**
 * Get Order Status by Order Number (Latest from getUserOrderDetail)
 * Check order verification status (including liveness)
 *
 * This uses getUserOrderDetail which returns the LATEST order data
 * (listOrders may return cached data)
 *
 * additionalKycVerify values:
 * 0 = not required
 * 1 = not verified (pending)
 * 2 = verified (✅ liveness completed)
 */
async function getOrderStatusByOrderNumber(orderNumber) {
  return withRetry(async () => {
    // Read additionalKycVerify directly from listOrders.
    //
    // We do NOT use getUserOrderDetail here: it returns -31002 "illegal parameter"
    // intermittently for all orders regardless of parameter, so it's unreliable.
    // Empirically, listOrders returns an accurate additionalKycVerify for every order
    // (1 for pending-liveness orders, 2 for verified ones), which is exactly what we
    // need. Values: 0=not required, 1=pending, 2=verified.
    const listRes = await axios.post(
      `${url(sellerBinanceConfig.endpoints.listOrders)}?${buildSignedQuery({})}`,
      {
        orderStatusList: [ORDER_STATUS.WAIT_PAYMENT, ORDER_STATUS.WAIT_RELEASE],
        tradeType: 'SELL',
        page: 1,
        rows: 100,
      },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    const listData = listRes.data?.data || listRes.data;
    const list = Array.isArray(listData) ? listData : (listData?.orderList || listData?.data || []);
    const order = list.find(o => o.orderNumber === orderNumber);

    if (!order) {
      return {
        success: false,
        message: 'Order not found in pending orders',
      };
    }

    return {
      success: true,
      orderNumber: order.orderNumber,
      advNo: order.advNo,
      orderStatus: order.orderStatus,
      additionalKycVerify: order.additionalKycVerify,
      raw: order,
      source: 'listOrders',
    };
  }, 3, 3000, `getOrderStatusByOrderNumber:${orderNumber}`);
}

/**
 * Get an order's status across ALL states — including COMPLETED (4) and
 * CANCELLED (6/7), which getOrderStatusByOrderNumber (pending-only) can't see.
 *
 * listOrders with orderStatusList [1,2,3,4,6,7] returns finished orders too, so
 * this is how the poller reliably detects completion/cancellation (to fire the
 * thank-you message + re-order cooldown). Returns { success, orderStatus } or
 * { success:false } when the order isn't in the recent window.
 */
async function getOrderStatusAllStates(orderNumber) {
  return withRetry(async () => {
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.listOrders)}?${buildSignedQuery({})}`,
      {
        orderStatusList: [1, 2, 3, 4, 6, 7],
        tradeType: 'SELL',
        page: 1,
        rows: 50,
      },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
    const order = list.find((o) => o.orderNumber === orderNumber);
    if (!order) return { success: false, message: 'Order not in recent list' };
    return {
      success: true,
      orderNumber: order.orderNumber,
      orderStatus: order.orderStatus,
      additionalKycVerify: order.additionalKycVerify,
      raw: order,
    };
  }, 3, 3000, `getOrderStatusAllStates:${orderNumber}`);
}

/**
 * Retrieve the seller's chat WSS credential (SELLER key).
 * Returns { chatWssUrl, listenKey, listenToken } used to open the chat WebSocket.
 * The REST sendMessage endpoint returns 404 on Binance — sending must go over WSS
 * (same as the buyer side), so sellerChatService uses this to connect.
 */
async function getChatCredential(orderNo) {
  return withRetry(async () => {
    // Match the buyer side EXACTLY (verified working): empty params (listenKey is
    // per-USER, not per-order) and the clientType=WEB header. Using orderNo params
    // or the PC header makes Binance reject the chat WSS with ILLEGAL_PARAM.
    const qs = buildSignedQuery({});
    const res = await axios.get(
      `${url(sellerBinanceConfig.endpoints.chatCredential)}?${qs}`,
      { headers: headers({ clientType: 'WEB' }), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const data = res.data?.data || res.data;
    if (!data?.listenKey || !data?.listenToken) {
      throw new Error(`chatCredential missing listenKey: ${JSON.stringify(res.data).slice(0, 150)}`);
    }
    return {
      chatWssUrl: data.chatWssUrl,
      listenKey: data.listenKey,
      listenToken: data.listenToken,
    };
  }, 3, 3000, `getChatCredential:${orderNo}`);
}

/**
 * Send Chat Message (REST) — NOTE: Binance returns 404 for this endpoint, so it
 * is NOT used. Kept for reference. Seller messages are sent over WSS via
 * sellerChatService (see getChatCredential).
 * Endpoint: POST /sapi/v1/c2c/chat/sendMessage
 */
async function sendMessage(orderNo, content, msgType = 'TEXT') {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.sendMessage)}?${qs}`,
      {
        orderNo,
        content,
        msgType
      },
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    return {
      success: res.data?.code === 0 || res.status === 200,
      message: res.data?.message || 'Message sent'
    };
  }, 3, 3000, `sendMessage:${orderNo}`);
}

/**
 * Get Chat Messages for an order
 * Endpoint: GET /sapi/v1/c2c/chat/retrieveChatMessagesWithPagination
 * Returns the raw message array (newest first).
 */
async function getChatMessages(orderNo, rows = 50) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNo, page: 1, rows, sort: 'desc' });
    const res = await axios.get(
      `${url(sellerBinanceConfig.endpoints.chatMessages)}?${qs}`,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );
    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.list || data?.data || []);
    return { success: true, messages: list };
  }, 3, 3000, `getChatMessages:${orderNo}`);
}

/**
 * Get images the BUYER uploaded in the order chat (Method 2 - document upload).
 *
 * Chat messages with type='image' carry imageUrl/thumbnailUrl (see SAPI v7.4
 * RetrieveChatMessagesWithPaginationResp). `self` is true for messages WE sent,
 * so buyer uploads are the ones with self !== true.
 *
 * Returns { success, images: [{ id, uuid, imageUrl, thumbnailUrl, imageType,
 * width, height, createTime, fromNickName }], count }, oldest-first.
 */
async function getBuyerUploadedImages(orderNo, rows = 50) {
  try {
    const { messages } = await getChatMessages(orderNo, rows);

    const images = (messages || [])
      .filter(m => m?.type === 'image' && m.self !== true && m.imageUrl)
      .map(m => ({
        id: m.id,
        uuid: m.uuid,
        imageUrl: m.imageUrl,
        thumbnailUrl: m.thumbnailUrl,
        imageType: m.imageType,
        width: m.width,
        height: m.height,
        createTime: m.createTime,
        fromNickName: m.fromNickName,
      }))
      // getChatMessages returns newest-first; upload order is what matters here.
      .sort((a, b) => (a.createTime || 0) - (b.createTime || 0));

    return { success: true, images, count: images.length };
  } catch (error) {
    return {
      success: false,
      images: [],
      count: 0,
      message: error.response?.data?.msg || error.message,
    };
  }
}

/**
 * Get TEXT messages the BUYER sent in the order chat (Method 2 OTP flow — the
 * buyer replies with their mobile number, then the OTP). Oldest-first, with a
 * stable `id` so the caller can process only new messages.
 */
async function getBuyerTextMessages(orderNo, rows = 50) {
  try {
    const { messages } = await getChatMessages(orderNo, rows);
    const texts = (messages || [])
      .filter((m) => m?.type === 'text' && m.self !== true && (m.content || m.message))
      .map((m) => ({
        id: m.id,
        uuid: m.uuid,
        content: m.content || m.message,
        createTime: m.createTime,
        fromNickName: m.fromNickName,
      }))
      .sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
    return { success: true, messages: texts, count: texts.length };
  } catch (error) {
    return { success: false, messages: [], count: 0, message: error.response?.data?.msg || error.message };
  }
}

/**
 * Detect liveness completion via Binance chat system message.
 *
 * When the buyer completes the liveness/additional-KYC check, Binance posts a
 * system message to the order chat whose content JSON has:
 *   type = "liveness_check_complete_maker"
 * (verified empirically — this is the reliable signal; additionalKycVerify in
 * listOrders does NOT flip to 2 in real time.)
 *
 * Returns { success, livenessComplete, message }.
 */
async function checkLivenessViaChat(orderNo) {
  try {
    const { messages } = await getChatMessages(orderNo, 50);

    for (const msg of messages) {
      if (msg?.type !== 'system' || typeof msg.content !== 'string') continue;
      // content is a JSON string; check for the completion type without full parse first
      if (msg.content.includes('liveness_check_complete')) {
        let parsed = null;
        try { parsed = JSON.parse(msg.content); } catch (_) { /* keep raw */ }
        return {
          success: true,
          livenessComplete: true,
          messageType: parsed?.type || 'liveness_check_complete',
          raw: msg,
        };
      }
    }

    return { success: true, livenessComplete: false };
  } catch (error) {
    return {
      success: false,
      livenessComplete: false,
      message: error.response?.data?.msg || error.message,
    };
  }
}

/**
 * Update seller ad with new parameters (eligibility criteria, etc)
 * Uses seller API key - for P2P ad updates only
 * CRITICAL: advNo goes in BODY, signature includes only timestamp
 */
async function updateAd(advNo, updates = {}) {
  return withRetry(async () => {
    console.log(`\n📡 [SELLER BINANCE] Calling updateAd`);
    console.log(`   Ad No: ${advNo}`);
    console.log(`   Fields to update: ${Object.keys(updates).join(', ')}`);

    // Build query string with ONLY timestamp (for signature)
    // advNo goes in the body, NOT in query
    const qs = buildSignedQuery({});

    // Payload contains advNo + all update fields
    const payload = {
      advNo,
      ...updates,
    };

    console.log(`\n   📋 EXACT PAYLOAD BEING SENT:`);
    console.log(`   Query: [timestamp & signature only]`);
    console.log(`   Body: ${JSON.stringify(payload, null, 2)}`);
    console.log(`\n   Using Seller API Key: ${sellerBinanceConfig.apiKey.substring(0, 10)}...`);

    logger.info('Updating Binance ad (seller)', {
      advNo,
      updateFields: Object.keys(updates),
    });

    console.log(`   Sending POST request to: /sapi/v1/c2c/ads/update`);
    const res = await axios.post(
      `${url('/sapi/v1/c2c/ads/update')}?${qs}`,
      payload,
      { headers: headers(), timeout: 12000, httpsAgent: ipv4Agent }
    );

    console.log(`   ✅ Binance API Response received`);
    console.log(`   Status: ${res.status}`);
    console.log(`   Data: ${JSON.stringify(res.data, null, 2)}`);

    logger.info('Binance ad updated successfully (seller)', {
      advNo,
      response: res.data,
    });

    return res.data;
  }, 3, 3000, 'updateAd');
}

module.exports = {
  ORDER_STATUS,
  getPendingSellOrders,
  getOrderDetail,
  getOrderStatusByOrderNumber,
  getOrderStatusAllStates,
  getCounterPartyOrderStats,
  getUserDetails,
  getSellerUpiDetails,
  verifyAdditionalKyc,
  checkIfCanReleaseCoin,
  releaseCoin,
  releaseOrder,
  getRsaPublicKey,
  encryptFundPassword,
  sendMessage,
  getChatCredential,
  getChatMessages,
  checkLivenessViaChat,
  getBuyerUploadedImages,
  getBuyerTextMessages,
  updateAd
};
