const logger = require('../../utils/logger');
const sellerAdService = require('../services/sellerAdService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const { getSellerIdFromRequest } = require('../utils/sellerUtils');

/**
 * ===== SELLER ADS CONTROLLER =====
 * API endpoints for ad management
 */
class SellerAdsController {

  /**
   * GET /api/seller/ads
   * Get all ads for current seller with their rules
   */
  async getAds(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req); // From auth middleware

      logger.info('Fetching seller ads', { sellerId });

      const ads = await sellerAdService.getSellerAds(sellerId, true);

      if (!ads || ads.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          message: 'No active ads found'
        });
      }

      // Format response with rule summary + ALL Binance data
      const formattedAds = ads.map(ad => ({
        // Basic Info
        id: ad.id,
        adNo: ad.ad_no,
        asset: ad.asset,
        fiatUnit: ad.fiat_unit,
        fiatSymbol: ad.fiat_symbol || '₹',

        // Pricing (convert strings to numbers)
        price: parseFloat(ad.price_rate) || 0,
        priceType: ad.price_type,  // 1=FIXED, 2=FLOATING
        priceFloatingRatio: parseFloat(ad.price_floating_ratio) || 0,
        commissionRate: parseFloat(ad.commission_rate) || 0,

        // Order Amounts
        minOrder: parseFloat(ad.min_order_amount) || 0,
        maxOrder: parseFloat(ad.max_order_amount) || 0,
        surplusAmount: parseFloat(ad.surplus_amount) || 0,
        initAmount: parseFloat(ad.init_amount) || 0,

        // Ad Details
        classify: ad.classify,
        tradeType: ad.trade_type,
        advStatus: ad.ad_status,
        isActive: ad.is_active,

        // Buyer Requirements
        buyerKycRequired: ad.buyer_kyc_required,
        buyerRegDaysLimit: parseInt(ad.buyer_reg_days_limit) || 0,
        buyerBtcPositionLimit: parseFloat(ad.buyer_btc_position_limit) || 0,

        // Trade Counts
        userBuyTradeCountMin: parseInt(ad.user_buy_trade_count_min) || 0,
        userBuyTradeCountMax: parseInt(ad.user_buy_trade_count_max) || 99999,
        userSellTradeCountMin: parseInt(ad.user_sell_trade_count_min) || 0,
        userSellTradeCountMax: parseInt(ad.user_sell_trade_count_max) || 99999,
        userAllTradeCountMin: parseInt(ad.user_all_trade_count_min) || 0,
        userAllTradeCountMax: parseInt(ad.user_all_trade_count_max) || 99999,

        // Completion Requirements
        userTradeCompleteCountMin: parseInt(ad.user_trade_complete_count_min) || 0,
        userTradeCompleteRateMin: parseFloat(ad.user_trade_complete_rate_min) || 0,

        // Trade Volume
        userTradeVolumeMin: parseFloat(ad.user_trade_volume_min) || 0,
        userTradeVolumeMax: parseFloat(ad.user_trade_volume_max) || 0,

        // Payment & Remarks
        payTimeLimit: ad.pay_time_limit || 0,
        remarks: ad.remarks || '',
        autoReplyMsg: ad.auto_reply_msg || '',
        offlineReason: ad.offline_reason || '',

        // Decimal Precision
        assetScale: ad.asset_scale || 8,
        fiatScale: ad.fiat_scale || 2,
        priceScale: ad.price_scale || 2,

        // Timestamps
        createdAt: ad.created_at,
        updatedAt: ad.updated_at,

        // Trade Methods (Payment methods from Binance)
        tradeMethods: (ad.tradeMethods || []).map(tm => ({
          payId: tm.pay_id,
          payType: tm.pay_type,
          identifier: tm.identifier,
          tradeMethodName: tm.trade_method_name,
          iconUrl: tm.icon_url,
          iconUrlColor: tm.icon_url_color,
          commissionRate: parseFloat(tm.commission_rate) || 0
        })),

        // Rules & Configuration
        rules: {
          eligibility: {
            min30dayTrades: ad.rules?.min_30day_trades || 0,
            min30dayCompletionRate: ad.rules?.min_30day_completion_rate || 0,
            maxAvgReleaseTime: ad.rules?.max_avg_release_time || 0,
            maxAvgPayTime: ad.rules?.max_avg_pay_time || 0,
            requiredTradeType: ad.rules?.required_trade_type || 'ANY',
            minRegisteredDays: ad.rules?.min_registered_days || 0,
            minFirstTradeDays: ad.rules?.min_first_trade_days || 0,
            minTradingCounterparty: ad.rules?.min_trading_counterparty || 0,
            minAllTradesCount: ad.rules?.min_all_trades_count || 0,
            minBuyOrdersCount: ad.rules?.min_buy_orders_count || 0,
            minSellOrdersCount: ad.rules?.min_sell_orders_count || 0
          },
          methods: {
            method1: {
              name: 'Liveness Check',
              enabled: ad.rules?.method1_liveness_enabled || false
            },
            method2: {
              name: 'Documents + OTP',
              enabled: ad.rules?.method2_documents_enabled || false,
              mobileVerification: ad.rules?.method2_mobile_verification_enabled || false
            },
            method3: {
              name: 'Full Verification',
              enabled: ad.rules?.method3_full_enabled || false,
              mobileVerification: ad.rules?.method3_mobile_verification_enabled || false,
              paymentLink: ad.rules?.method3_payment_link_enabled || false,
              paymentGateway: ad.rules?.method3_payment_gateway || 'razorpay',
              deliveryMethod: ad.rules?.method3_delivery_method || 'payment_link'
            }
          }
        },
        summary: ad.rules ? sellerAdService.getRuleSummary(ad.rules) : { methods: '', minTradesCount: 0, minCompletionRate: 0, minRegisteredDays: 0 }
      }));

      logger.info(`✅ Fetched ${formattedAds.length} ads`, { sellerId });

      res.status(200).json({
        success: true,
        data: formattedAds,
        count: formattedAds.length
      });

    } catch (error) {
      logger.error(`Get ads error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/ads/:adNo
   * Get specific ad with full configuration
   */
  async getAdDetail(req, res) {
    try {
      const { adNo } = req.params;
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching ad detail', { sellerId, adNo });

      const ad = await sellerAdService.getAdWithRules(adNo);

      if (!ad) {
        return res.status(404).json({
          success: false,
          error: 'Ad not found'
        });
      }

      // Verify seller owns this ad
      if (ad.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this ad'
        });
      }

      const formatted = {
        id: ad.id,
        adNo: ad.ad_no,
        asset: ad.asset,
        fiatUnit: ad.fiat_unit,
        price: ad.price_rate || 0,
        minOrder: ad.min_order_amount || 0,
        maxOrder: ad.max_order_amount || 0,
        isActive: ad.is_active,
        createdAt: ad.created_at,
        updatedAt: ad.updated_at,
        rules: {
          eligibility: {
            min30dayTrades: ad.rules.min_30day_trades,
            min30dayCompletionRate: ad.rules.min_30day_completion_rate,
            maxAvgReleaseTime: ad.rules.max_avg_release_time,
            maxAvgPayTime: ad.rules.max_avg_pay_time,
            requiredTradeType: ad.rules.required_trade_type,
            minRegisteredDays: ad.rules.min_registered_days,
            minFirstTradeDays: ad.rules.min_first_trade_days,
            minTradingCounterparty: ad.rules.min_trading_counterparty,
            minAllTradesCount: ad.rules.min_all_trades_count,
            minBuyOrdersCount: ad.rules.min_buy_orders_count,
            minSellOrdersCount: ad.rules.min_sell_orders_count
          },
          methods: {
            method1: {
              name: 'Liveness Check',
              enabled: ad.rules.method1_liveness_enabled
            },
            method2: {
              name: 'Documents + OTP',
              enabled: ad.rules.method2_documents_enabled,
              mobileVerification: ad.rules.method2_mobile_verification_enabled
            },
            method3: {
              name: 'Full Verification',
              enabled: ad.rules.method3_full_enabled,
              mobileVerification: ad.rules.method3_mobile_verification_enabled,
              paymentLink: ad.rules.method3_payment_link_enabled,
              paymentGateway: ad.rules.method3_payment_gateway,
              deliveryMethod: ad.rules.method3_delivery_method
            }
          }
        }
      };

      res.status(200).json({
        success: true,
        data: formatted
      });

    } catch (error) {
      logger.error(`Get ad detail error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * PUT /api/seller/ads/:adNo/rules
   * Update ad eligibility rules and verification methods
   */
  async updateAdRules(req, res) {
    try {
      const { adNo } = req.params;
      const sellerId = getSellerIdFromRequest(req);
      const rulesData = req.body;

      logger.info('Updating ad rules', { sellerId, adNo });

      // Verify seller owns this ad
      const ad = await sellerAdService.getAdWithRules(adNo);
      if (!ad) {
        return res.status(404).json({
          success: false,
          error: 'Ad not found'
        });
      }

      if (ad.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this ad'
        });
      }

      // Validate rules
      const validation = sellerAdService.validateRules(rulesData);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          errors: validation.errors
        });
      }

      // Update rules
      const result = await sellerAdService.updateAdRules(sellerId, adNo, rulesData);

      if (!result.success) {
        return res.status(500).json({
          success: false,
          error: result.error || 'Failed to update rules'
        });
      }

      // Fetch updated ad
      const updatedAd = await sellerAdService.getAdWithRules(adNo);

      logger.info(`✅ Ad rules updated`, { sellerId, adNo });

      res.status(200).json({
        success: true,
        message: 'Ad rules updated successfully',
        data: {
          adNo: updatedAd.ad_no,
          rules: updatedAd.rules,
          summary: sellerAdService.getRuleSummary(updatedAd.rules)
        }
      });

    } catch (error) {
      logger.error(`Update ad rules error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/seller/ads/:adNo/toggle
   * Enable/disable ad
   */
  async toggleAd(req, res) {
    try {
      const { adNo } = req.params;
      const { isActive } = req.body;
      const sellerId = getSellerIdFromRequest(req);

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'isActive must be a boolean'
        });
      }

      logger.info('Toggling ad status', { sellerId, adNo, isActive });

      const ad = await sellerAdService.getAdWithRules(adNo);
      if (!ad) {
        return res.status(404).json({
          success: false,
          error: 'Ad not found'
        });
      }

      if (ad.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this ad'
        });
      }

      // Update ad status in database
      await sellerOrderDbService.updateAdStatus(adNo, isActive);

      logger.info(`✅ Ad toggled`, { sellerId, adNo, isActive });

      res.status(200).json({
        success: true,
        message: `Ad ${isActive ? 'enabled' : 'disabled'} successfully`,
        data: {
          adNo,
          isActive
        }
      });

    } catch (error) {
      logger.error(`Toggle ad error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new SellerAdsController();
