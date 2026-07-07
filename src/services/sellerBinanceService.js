/**
 * Seller-specific Binance Service
 * Uses seller API keys to fetch seller ads and order information
 *
 * NOTE: Uses BINANCE_SELLER_API_KEY and BINANCE_SELLER_SECRET_KEY from .env
 * These credentials must have "Spot & Margin Trading" and C2C permission
 */

const axios = require('axios');
const crypto = require('crypto');
const sellerBinanceConfig = require('../config/sellerBinanceConfig');
const { buildSignedQuery, withRetry } = require('../utils/helpers');
const logger = require('../utils/logger');

// Build signature for seller with body parameters
// IMPORTANT: This must match test-seller-api.js logic for consistency
function buildSellerSignature(params = {}) {
  const timestamp = Date.now();  // ← Use Date.now() directly, not buildSignedQuery()

  // For POST with body, signature includes only timestamp + signature
  // Body params go in request body, not in query string
  const queryObject = {
    timestamp,
    ...params,
  };

  const queryString = Object.entries(queryObject)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', sellerBinanceConfig.secretKey)
    .update(queryString)
    .digest('hex');

  return `${queryString}&signature=${signature}`;
}

function headers(extra = {}) {
  return {
    'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
    'Content-Type': 'application/json',
    'clientType': 'PC',
    ...extra,
  };
}

/**
 * Get seller's own ads from Binance
 * Uses BINANCE_SELLER_API_KEY credentials
 *
 * Correct endpoint (Binance SAPI v7.4):
 * POST /sapi/v1/c2c/ads/listWithPagination
 *
 * CRITICAL: Must include "clientType: PC" header!
 * CRITICAL: Signature must be built with only timestamp (body params go in request body)
 */
async function getSellerAds(page = 1, rows = 50) {
  console.log(`\n📡 [SELLER BINANCE] Fetching seller ads (page=${page}, rows=${rows})`);
  console.log(`📍 [SELLER BINANCE] API Key: ${sellerBinanceConfig.apiKey ? sellerBinanceConfig.apiKey.substring(0, 15) + '...' : 'NOT SET'}`);

  try {
    // Build body with search parameters (SAPI v7.4 requirement)
    const body = {
      page,
      rows,
      tradeType: 'SELL'  // Get seller ads (where seller is offering crypto)
    };

    console.log(`📦 [SELLER BINANCE] Request body:`, JSON.stringify(body));

    // Build signature - ONLY timestamp in query string, body params separate
    const queryString = buildSellerSignature();  // ← Returns full query string with signature
    const endpoint = '/sapi/v1/c2c/ads/listWithPagination';
    const requestUrl = `${sellerBinanceConfig.baseUrl}${endpoint}?${queryString}`;

    console.log(`🔄 [SELLER BINANCE] Endpoint: ${endpoint}`);
    console.log(`🌐 [SELLER BINANCE] URL: ${requestUrl.substring(0, 120)}...`);

    // CRITICAL: Must include clientType header!
    const res = await axios.post(
      requestUrl,
      body,
      {
        headers: {
          'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
          'Content-Type': 'application/json',
          'clientType': 'PC'  // ← REQUIRED by Binance SAPI v7.4!
        },
        timeout: 8000
      }
    );

    console.log(`✅ [SELLER BINANCE] Status: ${res.status}`);

    // Debug: Log full response structure
    console.log(`📍 [SELLER BINANCE] Response keys:`, Object.keys(res.data || {}));
    console.log(`📍 [SELLER BINANCE] Full response:`, JSON.stringify(res.data).substring(0, 200));

    // Parse response - try multiple paths
    let adsList = [];
    if (res.data?.data?.data) {
      adsList = res.data.data.data;
      console.log(`📍 [SELLER BINANCE] Found ads at: res.data.data.data`);
    } else if (res.data?.data) {
      adsList = res.data.data;
      console.log(`📍 [SELLER BINANCE] Found ads at: res.data.data`);
    } else if (Array.isArray(res.data)) {
      adsList = res.data;
      console.log(`📍 [SELLER BINANCE] Found ads at: res.data (array)`);
    }

    console.log(`📦 [SELLER BINANCE] Found ${adsList.length} ads`);
    if (adsList.length > 0) {
      console.log(`📋 [SELLER BINANCE] Sample ad:`, {
        advNo: adsList[0].advNo,
        asset: adsList[0].asset,
        price: adsList[0].price,
        tradeType: adsList[0].tradeType
      });
    }

    logger.info('✅ [SELLER BINANCE] Fetched seller ads from Binance', {
      count: adsList.length,
      endpoint,
      page
    });

    // Map to expected format
    return adsList.map((a) => ({
      advNo: a.advNo,
      tradeType: a.tradeType,
      asset: a.asset,
      fiat: a.fiatUnit,
      price: a.price,
      minSingleTransAmount: a.minSingleTransAmount,
      maxSingleTransAmount: a.maxSingleTransAmount,
      advStatus: a.advStatus,
      surplusAmount: a.surplusAmount,
      classify: a.classify,
      priceType: a.priceType,
      priceFloatingRatio: a.priceFloatingRatio,
      commissionRate: a.commissionRate,
      fiatUnit: a.fiatUnit,
      fiatSymbol: a.fiatSymbol,
      initAmount: a.initAmount,
      buyerKycLimit: a.buyerKycLimit,
      buyerRegDaysLimit: a.buyerRegDaysLimit,
      buyerBtcPositionLimit: a.buyerBtcPositionLimit,
      userBuyTradeCountMin: a.userBuyTradeCountMin,
      userBuyTradeCountMax: a.userBuyTradeCountMax,
      userSellTradeCountMin: a.userSellTradeCountMin,
      userSellTradeCountMax: a.userSellTradeCountMax,
      userAllTradeCountMin: a.userAllTradeCountMin,
      userAllTradeCountMax: a.userAllTradeCountMax,
      userTradeCompleteCountMin: a.userTradeCompleteCountMin,
      userTradeCompleteRateMin: a.userTradeCompleteRateMin,
      userTradeVolumeMin: a.userTradeVolumeMin,
      userTradeVolumeMax: a.userTradeVolumeMax,
      payTimeLimit: a.payTimeLimit,
      remarks: a.remarks,
      autoReplyMsg: a.autoReplyMsg,
      offlineReason: a.offlineReason,
      assetScale: a.assetScale,
      fiatScale: a.fiatScale,
      priceScale: a.priceScale,
      createTime: a.createTime,
      advUpdateTime: a.advUpdateTime,
      tradeMethods: a.tradeMethods || [],
      tradeMethodCommissionRateVoList: a.tradeMethodCommissionRateVoList || [],
      raw: a,
    }));

  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;

    console.error(`❌ [SELLER BINANCE] Error (${status}): ${errorMsg}`);
    console.error(`📍 [SELLER BINANCE] Full error:`, error.response?.data || error.message);

    logger.error(`❌ [SELLER BINANCE] Failed to fetch ads`, {
      status,
      error: errorMsg,
      endpoint: '/sapi/v1/c2c/ads/listWithPagination'
    });

    throw error;
  }
}

/**
 * Get specific seller ad details
 */
async function getSellerAdDetail(advNo) {
  return withRetry(async () => {
    const qs = buildSignedQuery({ advNo });
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.queryAd)}?${qs}`,
      {},
      { headers: headers(), timeout: 12000 }
    );

    const d = res.data?.data || res.data;
    if (!d) throw new Error(`Empty ad detail for ${advNo}`);

    logger.info('📥 Fetched seller ad detail', { advNo });

    return {
      advNo:               d.advNo || d.id,
      tradeType:           d.tradeType,
      asset:               d.asset,
      fiat:                d.fiatUnit || d.fiat,
      price:               d.price,
      minSingleTransAmount: d.minSingleTransAmount || d.minAmount,
      maxSingleTransAmount: d.maxSingleTransAmount || d.maxAmount,
      advStatus:           d.advStatus || d.status,
      paymentMethod:       d.paymentMethod,
      remark:              d.remark,
      raw:                 d,
    };
  }, 2, 3000, `getSellerAdDetail:${advNo}`);
}

/**
 * Get seller's own orders (where seller is the counterparty)
 */
async function getSellerOrders(page = 1, rows = 50, tradeType = 'SELL') {
  return withRetry(async () => {
    const qs = buildSignedQuery({});
    const res = await axios.post(
      `${url(sellerBinanceConfig.endpoints.listOrders)}?${qs}`,
      {
        tradeType,  // SELL = buyer perspective, seller is recipient
        page,
        rows,
      },
      { headers: headers(), timeout: 12000 }
    );

    const d = res.data?.data || res.data;
    const list = Array.isArray(d) ? d : (d?.orderList || d?.data || []);

    logger.info('📥 Fetched seller orders from Binance', {
      count: list.length,
      tradeType,
      page
    });

    return list;
  }, 2, 3000, `getSellerOrders:${page}`);
}

/**
 * Check if seller has this ad
 */
async function verifySellerOwnsAd(advNo) {
  try {
    const ad = await getSellerAdDetail(advNo);
    return !!ad;
  } catch (error) {
    logger.warn(`Ad ${advNo} not owned by seller:`, error.message);
    return false;
  }
}

module.exports = {
  getSellerAds,
  getSellerAdDetail,
  getSellerOrders,
  verifySellerOwnsAd,
};
