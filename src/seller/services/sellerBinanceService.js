/**
 * Seller-specific Binance Service
 * Uses separate API keys and config for seller operations
 * Keeps buyer and seller accounts isolated
 */

const axios = require('axios');
const { sellerBinanceConfig } = require('../../config/sellerBinanceConfig');
const { buildSignedQuery, withRetry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

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
      { headers: headers(), timeout: 12000 }
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
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.queryCounterPartyOrderStatistic)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000 }
    );

    const data = res.data?.data || res.data;
    return {
      buy_orders_count: data?.purchaseOrderCount || 0,
      buy_orders_complete: data?.purchaseOrderCompleteCount || 0,
      buy_orders_complete_rate: parseFloat(data?.purchaseOrderCompleteRate) || 0,
      sell_orders_count: data?.saleOrderCount || 0,
      sell_orders_complete: data?.saleOrderCompleteCount || 0,
      sell_orders_complete_rate: parseFloat(data?.saleOrderCompleteRate) || 0,
      all_trades_count: data?.totalCompleteOrderCount || 0,
      completion_rate_30day: parseFloat(data?.totalCompleteRate) || 0,
      registered_days: data?.tradeDay || 0
    };
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
      { headers: headers(), timeout: 12000 }
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
 * Verify Additional KYC
 * Trigger liveness/verification after eligibility check passes
 * Endpoint: POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc
 */
async function verifyAdditionalKyc(orderNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ orderNumber: orderNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.verifiedAdditionalKyc)}?${qs}`,
      { orderNumber: orderNo },
      { headers: headers(), timeout: 12000 }
    );

    return {
      success: res.data?.code === 0 || res.status === 200,
      message: res.data?.message || 'Verification requested'
    };
  }, 3, 3000, `verifyAdditionalKyc:${orderNo}`);
}

/**
 * Send Chat Message
 * Send message to buyer via Binance chat
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
      { headers: headers(), timeout: 12000 }
    );

    return {
      success: res.data?.code === 0 || res.status === 200,
      message: res.data?.message || 'Message sent'
    };
  }, 3, 3000, `sendMessage:${orderNo}`);
}

module.exports = {
  ORDER_STATUS,
  getPendingSellOrders,
  getCounterPartyOrderStats,
  getUserDetails,
  verifyAdditionalKyc,
  sendMessage
};
