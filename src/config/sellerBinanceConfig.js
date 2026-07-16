/**
 * Seller-specific Binance Configuration
 * Uses separate API keys (BINANCE_SELLER_API_KEY, BINANCE_SELLER_SECRET_KEY)
 * for seller operations to keep buyer and seller accounts isolated
 */

require('dotenv').config();

const sellerBinanceConfig = {
  apiKey:    process.env.BINANCE_SELLER_API_KEY || process.env.BINANCE_API_KEY,
  secretKey: process.env.BINANCE_SELLER_SECRET_KEY || process.env.BINANCE_SECRET_KEY,
  baseUrl:   'https://api.binance.com',

  // WSS base — for real-time chat
  chatWssBase: 'wss://im.binance.com:443',

  // SAPI v7.4 Endpoints for seller operations
  // Note: Binance endpoint names vary by API version
  // Configurable via env for flexibility
  endpoints: {
    // My Ads - Multiple endpoint variations for compatibility
    searchMyAds:     process.env.BINANCE_SELLER_ADS_ENDPOINT || '/sapi/v1/c2c/user/ads/list',
    queryAd:         '/sapi/v1/c2c/user/ads/queryAd',

    // Orders
    listOrders:      '/sapi/v1/c2c/orderMatch/listOrders',
    orderDetail:     '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
    markPaid:        '/sapi/v1/c2c/orderMatch/markOrderAsPaid',
    cancelOrder:     '/sapi/v1/c2c/orderMatch/cancelOrder',
    canCancel:       '/sapi/v1/c2c/orderMatch/checkIfAllowedCancelOrder',

    // Chat
    chatCredential:  '/sapi/v1/c2c/chat/retrieveChatCredential',
    chatMessages:    '/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination',
    markMsgRead:     '/sapi/v1/c2c/chat/markOrderMessagesAsRead',
    sendMessage:     '/sapi/v1/c2c/chat/sendMessage',
    imagePresign:    '/sapi/v1/c2c/chat/image/pre-signed-url',

    // Payment methods
    paymentMethods:  '/sapi/v1/c2c/paymentMethod/getPayMethodByUserId',

    // Seller-specific endpoints for eligibility checking
    queryCounterPartyOrderStatistic: '/sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic',
    queryUser:                       '/sapi/v1/c2c/user/queryUser',
    verifiedAdditionalKyc:           '/sapi/v1/c2c/orderMatch/verifiedAdditionalKyc',
  }
};

module.exports = sellerBinanceConfig;
