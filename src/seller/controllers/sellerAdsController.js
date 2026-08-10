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

      // ?status=live  -> only ads that are Online on Binance (ad_status = 1)
      // ?status=all   -> every ad regardless of status (default)
      const status = String(req.query.status || 'all').toLowerCase();

      logger.info('Fetching seller ads', { sellerId, status });

      const allAds = await sellerAdService.getSellerAds(sellerId, true);

      // ad_status: 1 = Online (live), 3 = Offline, others = closed/expired
      const ads = status === 'live'
        ? (allAds || []).filter(a => Number(a.ad_status) === 1)
        : (allAds || []);

      if (!ads || ads.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          counts: {
            all: (allAds || []).length,
            live: (allAds || []).filter(a => Number(a.ad_status) === 1).length,
          },
          message: status === 'live' ? 'No live ads found' : 'No active ads found'
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
            // Each criterion has enabled flag + value (from database)
            min30dayTrades: {
              enabled: ad.rules?.min_30day_trades_enabled === 1 || ad.rules?.min_30day_trades_enabled === true,
              value: ad.rules?.min_30day_trades || 0
            },
            min30dayCompletionRate: {
              enabled: ad.rules?.min_30day_completion_rate_enabled === 1 || ad.rules?.min_30day_completion_rate_enabled === true,
              // Stored as a 0-1 decimal (Binance format); show as a 0-100 percentage.
              value: Math.round((ad.rules?.min_30day_completion_rate || 0) * 100)
            },
            minRegisteredDays: {
              enabled: ad.rules?.min_registered_days_enabled === 1 || ad.rules?.min_registered_days_enabled === true,
              value: ad.rules?.min_registered_days || 0
            },
            minAllTradesCount: {
              enabled: ad.rules?.min_all_trades_count_enabled === 1 || ad.rules?.min_all_trades_count_enabled === true,
              value: ad.rules?.min_all_trades_count || 0
            },
            minBuyOrdersCount: {
              enabled: ad.rules?.min_buy_orders_count_enabled === 1 || ad.rules?.min_buy_orders_count_enabled === true,
              value: ad.rules?.min_buy_orders_count || 0
            },
            minSellOrdersCount: {
              enabled: ad.rules?.min_sell_orders_count_enabled === 1 || ad.rules?.min_sell_orders_count_enabled === true,
              value: ad.rules?.min_sell_orders_count || 0
            },
            minTradeVolume: {
              enabled: ad.rules?.min_trade_volume_enabled === 1 || ad.rules?.min_trade_volume_enabled === true,
              value: ad.rules?.min_trade_volume || 0
            },
            maxTradeVolume: {
              enabled: ad.rules?.max_trade_volume_enabled === 1 || ad.rules?.max_trade_volume_enabled === true,
              value: ad.rules?.max_trade_volume || 0
            },
            minBtcHolding: {
              enabled: ad.rules?.min_btc_holding_enabled === 1 || ad.rules?.min_btc_holding_enabled === true,
              value: ad.rules?.min_btc_holding || 0
            }
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
          },
          cooldown: {
            enabled: ad.rules?.reorder_cooldown_enabled === 1 || ad.rules?.reorder_cooldown_enabled === true,
            hours: ad.rules?.reorder_cooldown_hours || 24
          }
        },
        summary: ad.rules ? sellerAdService.getRuleSummary(ad.rules) : { methods: '', minTradesCount: 0, minCompletionRate: 0, minRegisteredDays: 0 }
      }));

      logger.info(`✅ Fetched ${formattedAds.length} ads`, { sellerId, status });

      res.status(200).json({
        success: true,
        data: formattedAds,
        count: formattedAds.length,
        // Counts for BOTH filters so the UI can label the tabs without refetching
        counts: {
          all: (allAds || []).length,
          live: (allAds || []).filter(a => Number(a.ad_status) === 1).length,
        },
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
            min30dayTrades: {
              enabled: ad.rules.min_30day_trades_enabled === 1 || ad.rules.min_30day_trades_enabled === true,
              value: ad.rules.min_30day_trades || 0
            },
            min30dayCompletionRate: {
              enabled: ad.rules.min_30day_completion_rate_enabled === 1 || ad.rules.min_30day_completion_rate_enabled === true,
              // Stored as a 0-1 decimal (Binance format); show as a 0-100 percentage.
              value: Math.round((ad.rules.min_30day_completion_rate || 0) * 100)
            },
            minRegisteredDays: {
              enabled: ad.rules.min_registered_days_enabled === 1 || ad.rules.min_registered_days_enabled === true,
              value: ad.rules.min_registered_days || 0
            },
            minAllTradesCount: {
              enabled: ad.rules.min_all_trades_count_enabled === 1 || ad.rules.min_all_trades_count_enabled === true,
              value: ad.rules.min_all_trades_count || 0
            },
            minBuyOrdersCount: {
              enabled: ad.rules.min_buy_orders_count_enabled === 1 || ad.rules.min_buy_orders_count_enabled === true,
              value: ad.rules.min_buy_orders_count || 0
            },
            minSellOrdersCount: {
              enabled: ad.rules.min_sell_orders_count_enabled === 1 || ad.rules.min_sell_orders_count_enabled === true,
              value: ad.rules.min_sell_orders_count || 0
            },
            minTradeVolume: {
              enabled: ad.rules.min_trade_volume_enabled === 1 || ad.rules.min_trade_volume_enabled === true,
              value: ad.rules.min_trade_volume || 0
            },
            maxTradeVolume: {
              enabled: ad.rules.max_trade_volume_enabled === 1 || ad.rules.max_trade_volume_enabled === true,
              value: ad.rules.max_trade_volume || 0
            },
            minBtcHolding: {
              enabled: ad.rules.min_btc_holding_enabled === 1 || ad.rules.min_btc_holding_enabled === true,
              value: ad.rules.min_btc_holding || 0
            }
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
          },
          cooldown: {
            enabled: ad.rules.reorder_cooldown_enabled === 1 || ad.rules.reorder_cooldown_enabled === true,
            hours: ad.rules.reorder_cooldown_hours || 24
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

      logger.info('Updating ad rules', {
        sellerId,
        adNo,
        receivedFields: Object.keys(rulesData),
        methodsInPayload: {
          method1_liveness_enabled: rulesData.method1_liveness_enabled,
          method2_documents_enabled: rulesData.method2_documents_enabled,
          method3_full_enabled: rulesData.method3_full_enabled
        }
      });

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

      // Format rules with enabled flags
      const formattedRules = {
        eligibility: {
          min30dayTrades: {
            enabled: updatedAd.rules?.min_30day_trades_enabled === 1 || updatedAd.rules?.min_30day_trades_enabled === true,
            value: updatedAd.rules?.min_30day_trades || 0
          },
          min30dayCompletionRate: {
            enabled: updatedAd.rules?.min_30day_completion_rate_enabled === 1 || updatedAd.rules?.min_30day_completion_rate_enabled === true,
            // Stored as a 0-1 decimal (Binance format); show as a 0-100 percentage.
            value: Math.round((updatedAd.rules?.min_30day_completion_rate || 0) * 100)
          },
          minRegisteredDays: {
            enabled: updatedAd.rules?.min_registered_days_enabled === 1 || updatedAd.rules?.min_registered_days_enabled === true,
            value: updatedAd.rules?.min_registered_days || 0
          },
          minAllTradesCount: {
            enabled: updatedAd.rules?.min_all_trades_count_enabled === 1 || updatedAd.rules?.min_all_trades_count_enabled === true,
            value: updatedAd.rules?.min_all_trades_count || 0
          },
          minBuyOrdersCount: {
            enabled: updatedAd.rules?.min_buy_orders_count_enabled === 1 || updatedAd.rules?.min_buy_orders_count_enabled === true,
            value: updatedAd.rules?.min_buy_orders_count || 0
          },
          minSellOrdersCount: {
            enabled: updatedAd.rules?.min_sell_orders_count_enabled === 1 || updatedAd.rules?.min_sell_orders_count_enabled === true,
            value: updatedAd.rules?.min_sell_orders_count || 0
          },
          minTradeVolume: {
            enabled: updatedAd.rules?.min_trade_volume_enabled === 1 || updatedAd.rules?.min_trade_volume_enabled === true,
            value: updatedAd.rules?.min_trade_volume || 0
          },
          maxTradeVolume: {
            enabled: updatedAd.rules?.max_trade_volume_enabled === 1 || updatedAd.rules?.max_trade_volume_enabled === true,
            value: updatedAd.rules?.max_trade_volume || 0
          },
          minBtcHolding: {
            enabled: updatedAd.rules?.min_btc_holding_enabled === 1 || updatedAd.rules?.min_btc_holding_enabled === true,
            value: updatedAd.rules?.min_btc_holding || 0
          }
        },
        methods: {
          method1: {
            name: 'Liveness Check',
            enabled: updatedAd.rules?.method1_liveness_enabled === 1 || updatedAd.rules?.method1_liveness_enabled === true
          },
          method2: {
            name: 'Documents + OTP',
            enabled: updatedAd.rules?.method2_documents_enabled === 1 || updatedAd.rules?.method2_documents_enabled === true,
            mobileVerification: updatedAd.rules?.method2_mobile_verification_enabled === 1 || updatedAd.rules?.method2_mobile_verification_enabled === true
          },
          method3: {
            name: 'Full Verification',
            enabled: updatedAd.rules?.method3_full_enabled === 1 || updatedAd.rules?.method3_full_enabled === true,
            mobileVerification: updatedAd.rules?.method3_mobile_verification_enabled === 1 || updatedAd.rules?.method3_mobile_verification_enabled === true,
            paymentLink: updatedAd.rules?.method3_payment_link_enabled === 1 || updatedAd.rules?.method3_payment_link_enabled === true,
            paymentGateway: updatedAd.rules?.method3_payment_gateway || 'razorpay',
            deliveryMethod: updatedAd.rules?.method3_delivery_method || 'payment_link'
          }
        }
      };

      res.status(200).json({
        success: true,
        message: 'Ad rules updated successfully',
        data: {
          adNo: updatedAd.ad_no,
          rules: formattedRules,
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

  /**
   * POST /api/seller/ads/:adNo/sync-eligibility
   * Sync eligibility criteria from database to Binance ad
   */
  /**
   * PUT /api/seller/ads/:adNo/methods
   *
   * Save VERIFICATION METHODS only (Method 1/2/3 toggles).
   *
   * Methods are bot-side behaviour applied AFTER an order arrives:
   *   Method 1 -> check liveness
   *   Method 2 -> liveness + documents the buyer uploads in Binance chat
   *   Method 3 -> full verification
   * Binance has no concept of these, so this endpoint NEVER calls the Binance API.
   * That keeps method changes working even when a Binance ad update is rejected
   * (e.g. ads in advStatus=4 return error 187022).
   *
   * Body: { methods: { method1: {enabled}, method2: {enabled, mobileVerification},
   *                    method3: {enabled, mobileVerification, paymentLink,
   *                              paymentGateway, deliveryMethod} } }
   * Also accepts flat snake_case columns for convenience.
   */
  async updateAdMethods(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { adNo } = req.params;
      const { methods } = req.body || {};

      console.log(`\n⚙️  [METHODS] Updating verification methods (DB only, no Binance call)`);
      console.log(`   Ad No: ${adNo}`);

      // Verify the seller owns this ad
      const ad = await sellerAdService.getAdWithRules(adNo);
      if (!ad) {
        return res.status(404).json({ success: false, error: 'Ad not found' });
      }
      if (ad.seller_id !== sellerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized access to this ad' });
      }

      // Accept either the nested {methods:{...}} shape or flat snake_case fields.
      const asBool = (v) => v === true || v === 1 || v === '1';
      const payload = methods
        ? {
            method1_liveness_enabled: asBool(methods.method1?.enabled),
            method2_documents_enabled: asBool(methods.method2?.enabled),
            method2_mobile_verification_enabled: asBool(methods.method2?.mobileVerification),
            method3_full_enabled: asBool(methods.method3?.enabled),
            method3_mobile_verification_enabled: asBool(methods.method3?.mobileVerification),
            method3_payment_link_enabled: asBool(methods.method3?.paymentLink),
            method3_payment_gateway: methods.method3?.paymentGateway || 'razorpay',
            method3_delivery_method: methods.method3?.deliveryMethod || 'payment_link',
          }
        : {
            method1_liveness_enabled: asBool(req.body.method1_liveness_enabled),
            method2_documents_enabled: asBool(req.body.method2_documents_enabled),
            method2_mobile_verification_enabled: asBool(req.body.method2_mobile_verification_enabled),
            method3_full_enabled: asBool(req.body.method3_full_enabled),
            method3_mobile_verification_enabled: asBool(req.body.method3_mobile_verification_enabled),
            method3_payment_link_enabled: asBool(req.body.method3_payment_link_enabled),
            method3_payment_gateway: req.body.method3_payment_gateway || 'razorpay',
            method3_delivery_method: req.body.method3_delivery_method || 'payment_link',
          };

      // Methods are optional — admin may enable any, all, or none. With no
      // method enabled, orders skip verification and proceed directly.

      console.log(`   Methods:`, JSON.stringify(payload, null, 2));

      const result = await sellerAdService.updateAdMethods(sellerId, adNo, payload);
      if (!result.success) {
        return res.status(500).json({
          success: false,
          error: result.error || 'Failed to update methods',
        });
      }

      console.log(`   ✅ Methods saved to database`);
      logger.info('✅ Ad verification methods updated', { sellerId, adNo, methods: payload });

      return res.json({
        success: true,
        message: 'Verification methods updated',
        adNo,
        methods: {
          method1: { enabled: payload.method1_liveness_enabled },
          method2: {
            enabled: payload.method2_documents_enabled,
            mobileVerification: payload.method2_mobile_verification_enabled,
          },
          method3: {
            enabled: payload.method3_full_enabled,
            mobileVerification: payload.method3_mobile_verification_enabled,
            paymentLink: payload.method3_payment_link_enabled,
            paymentGateway: payload.method3_payment_gateway,
            deliveryMethod: payload.method3_delivery_method,
          },
        },
      });

    } catch (error) {
      logger.error(`Update ad methods error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * PUT /api/seller/ads/:adNo/cooldown
   *
   * Re-order cooldown is a BOT feature, not a Binance criterion — so this saves
   * ONLY to our DB and NEVER calls the Binance API. (Previously the cooldown rode
   * along with sync-eligibility, so a Binance sync failure also lost the cooldown.)
   *
   * Body: { enabled: boolean, hours: number }
   */
  async updateAdCooldown(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { adNo } = req.params;
      const enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1';
      const hours = Number(req.body.hours) > 0 ? Math.round(Number(req.body.hours)) : 24;

      console.log(`\n⏲️  [COOLDOWN] Updating re-order cooldown (DB only, no Binance call)`);
      console.log(`   Ad No: ${adNo} | enabled: ${enabled} | hours: ${hours}`);

      const ad = await sellerAdService.getAdWithRules(adNo);
      if (!ad) {
        return res.status(404).json({ success: false, error: 'Ad not found' });
      }
      if (ad.seller_id !== sellerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized access to this ad' });
      }

      const ok = await sellerOrderDbService.updateAdCooldown(sellerId, adNo, { enabled, hours });
      if (!ok) {
        return res.status(500).json({ success: false, error: 'Failed to save cooldown' });
      }

      logger.info('✅ Re-order cooldown updated', { sellerId, adNo, enabled, hours });
      return res.json({ success: true, message: 'Re-order cooldown updated', adNo, cooldown: { enabled, hours } });
    } catch (error) {
      logger.error(`Update ad cooldown error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * POST /api/seller/ads/:adNo/sync-eligibility
   *
   * ELIGIBILITY ONLY. Syncs buyer-eligibility criteria to the Binance ad and,
   * if Binance accepts, saves them to our DB.
   *
   * Verification methods are NOT handled here — they are bot-side behaviour with
   * no Binance equivalent. Use PUT /api/seller/ads/:adNo/methods for those.
   *
   * Body: { rules: { eligibility: {...} } }   // a `methods` key is ignored
   */
  async syncEligibilityToBinance(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { adNo } = req.params;
      const { rules: frontendRules } = req.body;

      console.log(`\n🔄 [SYNC] Starting eligibility sync to Binance (eligibility only)`);
      console.log(`   Seller ID: ${sellerId}`);
      console.log(`   Ad No: ${adNo}`);
      console.log(`   Rules from frontend:`, frontendRules ? 'YES' : 'NO (using DB)');
      logger.info('Syncing eligibility to Binance', { sellerId, adNo });

      // Step 1: Get current ad rules
      // If frontend sends rules, use those (they're the latest)
      // Otherwise fetch from database
      console.log(`\n📊 [SYNC] Step 1: Getting ad rules...`);
      let rules;

      if (frontendRules && frontendRules.eligibility) {
        console.log(`   ✅ Using rules from frontend (latest changes)`);
        rules = frontendRules.eligibility;
      } else {
        console.log(`   Using rules from database`);
        rules = await sellerOrderDbService.getAdRules(adNo);
      }

      if (!rules) {
        console.log(`   ❌ Ad rules not found in database`);
        logger.error(`❌ Ad rules not found for ad ${adNo}`);
        return res.status(404).json({
          success: false,
          error: 'Ad rules not found'
        });
      }
      console.log(`   ✅ Ad rules found`);
      console.log(`   Rules:`, JSON.stringify(rules, null, 2));

      // Import sellerBinanceService - uses seller API keys for P2P operations
      const sellerBinanceService = require('../services/sellerBinanceService');

      // Step 2: Build Binance update payload with only enabled criteria
      console.log(`\n🔨 [SYNC] Step 2: Building Binance payload...`);
      const binancePayload = {};

      // Helper function to safely parse integers
      const safeInt = (val) => {
        const parsed = parseInt(val);
        return isNaN(parsed) ? 0 : parsed;
      };

      // Helper function to safely parse floats
      const safeFloat = (val) => {
        const parsed = parseFloat(val);
        return isNaN(parsed) ? 0 : parsed;
      };

      // Helper to extract value from criteria object
      const getCriterionValue = (criterion) => {
        if (!criterion) return null;
        if (typeof criterion === 'object' && 'value' in criterion) {
          return criterion.value;
        }
        return criterion;
      };

      // Helper to check if criterion is enabled
      const isCriterionEnabled = (criterion) => {
        if (!criterion) return false;
        if (typeof criterion === 'object' && 'enabled' in criterion) {
          return criterion.enabled === true;
        }
        return false;
      };

      // Add eligibility criteria - include enabled AND send reset values for disabled ones
      console.log(`   Checking criteria...`);

      // Min 30-day trades — Binance field is userTradeCompleteCountMin (NOT
      // userTradeCountMin, which Binance silently ignores → criterion never set).
      if (isCriterionEnabled(rules.min30dayTrades)) {
        const val = getCriterionValue(rules.min30dayTrades);
        if (val) {
          binancePayload.userTradeCompleteCountMin = safeInt(val);
          binancePayload.userTradeCountFilterTime = 1; // 1 = last 30 days
          console.log(`   ✅ Min 30-day trades: ${binancePayload.userTradeCompleteCountMin}`);
        }
      } else {
        binancePayload.userTradeCompleteCountMin = 0;
        console.log(`   🔄 Min 30-day trades: RESET TO 0 (disabled)`);
      }

      // Min completion rate (userTradeCompleteRateMin)
      if (isCriterionEnabled(rules.min30dayCompletionRate)) {
        const val = getCriterionValue(rules.min30dayCompletionRate);
        if (val) {
          // Frontend sends a 0-100 percentage; Binance wants a 0-1 decimal.
          const pct = Math.min(100, Math.max(0, safeFloat(val)));
          const decimalRate = pct / 100;
          binancePayload.userTradeCompleteRateMin = decimalRate;
          binancePayload.userTradeCompleteRateFilterTime = 1;
          console.log(`   ✅ Min completion rate: ${pct}% → ${decimalRate}`);
        }
      } else {
        binancePayload.userTradeCompleteRateMin = 0;
        console.log(`   🔄 Min completion rate: RESET TO 0 (disabled)`);
      }

      // Min registered days — needs BOTH fields on Binance:
      //   buyerRegDaysLimit  (0/1) = the ENABLE flag (without this=1 the days are ignored)
      //   buyerRegisterLimit (days) = the actual value; Binance MAX is 180 days (hard cap)
      if (isCriterionEnabled(rules.minRegisteredDays)) {
        const val = safeInt(getCriterionValue(rules.minRegisteredDays));
        if (val > 0) {
          const days = Math.min(180, val); // Binance rejects > 180
          binancePayload.buyerRegDaysLimit = 1;
          binancePayload.buyerRegisterLimit = days;
          console.log(`   ✅ Min registered days: ${days}${val > 180 ? ` (capped from ${val}; Binance max is 180)` : ''}`);
        } else {
          binancePayload.buyerRegDaysLimit = 0;
          binancePayload.buyerRegisterLimit = 0;
        }
      } else {
        binancePayload.buyerRegDaysLimit = 0;
        binancePayload.buyerRegisterLimit = 0;
        console.log(`   🔄 Min registered days: RESET TO 0 (disabled)`);
      }

      // Min all trades count (userAllTradeCountMin)
      if (isCriterionEnabled(rules.minAllTradesCount)) {
        const val = getCriterionValue(rules.minAllTradesCount);
        if (val) {
          binancePayload.userAllTradeCountMin = safeInt(val);
          console.log(`   ✅ Min all trades: ${binancePayload.userAllTradeCountMin}`);
        }
      } else {
        binancePayload.userAllTradeCountMin = 0;
        console.log(`   🔄 Min all trades: RESET TO 0 (disabled)`);
      }

      // Min buy orders count (userBuyTradeCountMin)
      if (isCriterionEnabled(rules.minBuyOrdersCount)) {
        const val = getCriterionValue(rules.minBuyOrdersCount);
        if (val) {
          binancePayload.userBuyTradeCountMin = safeInt(val);
          console.log(`   ✅ Min buy orders: ${binancePayload.userBuyTradeCountMin}`);
        }
      } else {
        binancePayload.userBuyTradeCountMin = 0;
        console.log(`   🔄 Min buy orders: RESET TO 0 (disabled)`);
      }

      // Min sell orders count (userSellTradeCountMin)
      if (isCriterionEnabled(rules.minSellOrdersCount)) {
        const val = getCriterionValue(rules.minSellOrdersCount);
        if (val) {
          binancePayload.userSellTradeCountMin = safeInt(val);
          console.log(`   ✅ Min sell orders: ${binancePayload.userSellTradeCountMin}`);
        }
      } else {
        binancePayload.userSellTradeCountMin = 0;
        console.log(`   🔄 Min sell orders: RESET TO 0 (disabled)`);
      }

      // ADVANCED OPTIONS - Premium eligibility criteria

      // Option 1: Min trade volume (userTradeVolumeMin)
      if (isCriterionEnabled(rules.minTradeVolume)) {
        const val = getCriterionValue(rules.minTradeVolume);
        if (val) {
          binancePayload.userTradeVolumeMin = safeFloat(val);
          binancePayload.userTradeVolumeAsset = 'USDT';
          binancePayload.userTradeVolumeFilterTime = 2;
          console.log(`   ✅ Min trade volume: ${binancePayload.userTradeVolumeMin} USDT (premium)`);
        }
      } else {
        binancePayload.userTradeVolumeMin = 0;
        console.log(`   🔄 Min trade volume: RESET TO 0 (disabled)`);
      }

      // Option 2: Max trade volume (userTradeVolumeMax)
      if (isCriterionEnabled(rules.maxTradeVolume)) {
        const val = getCriterionValue(rules.maxTradeVolume);
        if (val) {
          binancePayload.userTradeVolumeMax = safeFloat(val);
          if (!binancePayload.userTradeVolumeAsset) {
            binancePayload.userTradeVolumeAsset = 'USDT';
          }
          if (!binancePayload.userTradeVolumeFilterTime) {
            binancePayload.userTradeVolumeFilterTime = 2;
          }
          console.log(`   ✅ Max trade volume: ${binancePayload.userTradeVolumeMax} USDT (premium)`);
        }
      } else {
        binancePayload.userTradeVolumeMax = 0;
        console.log(`   🔄 Max trade volume: RESET TO 0 (disabled)`);
      }

      // Option 3: Min BTC holding (buyerBtcPositionLimit)
      if (isCriterionEnabled(rules.minBtcHolding)) {
        const val = getCriterionValue(rules.minBtcHolding);
        if (val) {
          binancePayload.buyerBtcPositionLimit = safeFloat(val);
          console.log(`   ✅ Min BTC holding: ${binancePayload.buyerBtcPositionLimit} BTC (premium)`);
        }
      } else {
        binancePayload.buyerBtcPositionLimit = 0;
        console.log(`   🔄 Min BTC holding: RESET TO 0 (disabled)`);
      }

      console.log(`\n📦 [SYNC] Final Binance Payload:`);
      console.log(JSON.stringify(binancePayload, null, 2));

      logger.info('Binance payload to update', {
        adNo,
        payload: binancePayload
      });

      // Step 3: Call Binance API to update ad
      console.log(`\n🌐 [SYNC] Step 3: Calling Binance API /sapi/v1/c2c/ads/update...`);
      console.log(`   Endpoint: POST /sapi/v1/c2c/ads/update`);
      console.log(`   Ad No: ${adNo}`);

      const result = await sellerBinanceService.updateAd(adNo, binancePayload);

      console.log(`\n📡 [SYNC] Binance Response:`);
      console.log(JSON.stringify(result, null, 2));

      // Verify Binance response indicates success
      console.log(`\n✔️  [SYNC] Step 4: Validating Binance response...`);

      if (!result) {
        console.log(`   ❌ No response from Binance API`);
        logger.error(`❌ Binance returned no response for ad ${adNo}`);
        return res.status(500).json({
          success: false,
          error: 'Binance API returned no response'
        });
      }

      console.log(`   Response received. Checking status...`);
      console.log(`   - result.code: ${result.code}`);
      console.log(`   - result.success: ${result.success}`);
      console.log(`   - result.message: ${result.message || result.msg}`);

      // Binance returns success with code "000000" or "0"
      const isSuccess = (result.code === '0' || result.code === '000000' || result.success === true);

      if (!isSuccess) {
        const errorMsg = result?.message || result?.msg || 'Binance API returned error';
        console.log(`   ❌ Binance returned error: ${errorMsg}`);
        logger.error(`❌ Binance ad update failed`, {
          sellerId,
          adNo,
          binanceResponse: result,
          errorMsg
        });
        return res.status(500).json({
          success: false,
          error: `Binance ad update failed: ${errorMsg}`,
          binanceResponse: result
        });
      }

      console.log(`   ✅ Binance response valid - Update successful!`);
      logger.info('✅ Ad eligibility synced to Binance', {
        sellerId,
        adNo,
        result
      });

      // Step 5: Update database with the rules that were synced
      console.log(`\n💾 [SYNC] Step 5: Updating database with synced rules...`);

      const dbUpdates = {};

      // Core criteria - update enabled flags and values
      // If unchecked, set value to 0; if checked, use the value
      if (rules.min30dayTrades !== undefined) {
        const isEnabled = isCriterionEnabled(rules.min30dayTrades);
        dbUpdates.min_30day_trades_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_30day_trades = isEnabled ? (getCriterionValue(rules.min30dayTrades) || 0) : 0;
      }

      if (rules.min30dayCompletionRate !== undefined) {
        const isEnabled = isCriterionEnabled(rules.min30dayCompletionRate);
        dbUpdates.min_30day_completion_rate_enabled = isEnabled ? 1 : 0;
        if (isEnabled) {
          // Frontend always sends a 0-100 percentage; store as the 0-1 decimal
          // Binance uses. Clamp to [0,100] to avoid bad input.
          const pct = Math.min(100, Math.max(0, getCriterionValue(rules.min30dayCompletionRate) || 0));
          dbUpdates.min_30day_completion_rate = pct / 100;
        } else {
          dbUpdates.min_30day_completion_rate = 0;
        }
      }

      if (rules.minRegisteredDays !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minRegisteredDays);
        dbUpdates.min_registered_days_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_registered_days = isEnabled ? (getCriterionValue(rules.minRegisteredDays) || 0) : 0;
      }

      if (rules.minAllTradesCount !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minAllTradesCount);
        dbUpdates.min_all_trades_count_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_all_trades_count = isEnabled ? (getCriterionValue(rules.minAllTradesCount) || 0) : 0;
      }

      if (rules.minBuyOrdersCount !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minBuyOrdersCount);
        dbUpdates.min_buy_orders_count_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_buy_orders_count = isEnabled ? (getCriterionValue(rules.minBuyOrdersCount) || 0) : 0;
      }

      if (rules.minSellOrdersCount !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minSellOrdersCount);
        dbUpdates.min_sell_orders_count_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_sell_orders_count = isEnabled ? (getCriterionValue(rules.minSellOrdersCount) || 0) : 0;
      }

      // Advanced options - update enabled flags and values
      if (rules.minTradeVolume !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minTradeVolume);
        dbUpdates.min_trade_volume_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_trade_volume = isEnabled ? (getCriterionValue(rules.minTradeVolume) || 0) : 0;
      }

      if (rules.maxTradeVolume !== undefined) {
        const isEnabled = isCriterionEnabled(rules.maxTradeVolume);
        dbUpdates.max_trade_volume_enabled = isEnabled ? 1 : 0;
        dbUpdates.max_trade_volume = isEnabled ? (getCriterionValue(rules.maxTradeVolume) || 0) : 0;
      }

      if (rules.minBtcHolding !== undefined) {
        const isEnabled = isCriterionEnabled(rules.minBtcHolding);
        dbUpdates.min_btc_holding_enabled = isEnabled ? 1 : 0;
        dbUpdates.min_btc_holding = isEnabled ? (getCriterionValue(rules.minBtcHolding) || 0) : 0;
      }

      // Update database
      try {
        const updateResult = await sellerOrderDbService.updateAdRules(adNo, dbUpdates);
        console.log(`   ✅ Database updated successfully`);
        console.log(`   Updated fields:`, Object.keys(dbUpdates));
        logger.info('✅ Database rules updated', {
          adNo,
          updates: dbUpdates
        });
      } catch (dbError) {
        console.log(`   ⚠️  Database update failed: ${dbError.message}`);
        logger.warn(`Database update failed for ad ${adNo}`, { dbError });
        // Don't fail the entire request if DB update fails (Binance sync already succeeded)
      }

      console.log(`\n✅ [SYNC] SUCCESS - Ad eligibility synced to Binance and database updated!\n`);

      res.status(200).json({
        success: true,
        message: 'Ad eligibility criteria synced to Binance and database updated',
        data: {
          adNo,
          synced: binancePayload,
          dbUpdates: dbUpdates,
          binanceResponse: result
        }
      });

    } catch (error) {
      console.log(`\n❌ [SYNC] ERROR: ${error.message}`);
      console.log(`   Stack: ${error.stack}`);
      logger.error(`Sync eligibility to Binance error: ${error.message}`, { error });

      // Translate opaque Binance ad-lock errors into something actionable.
      // 187040 / -9000 = Binance is refusing to update THIS ad (risk-control lock,
      // frozen ad, or pending review) — not a config problem. Verified: the same
      // request succeeds on other ads. Admin must edit/re-create the ad on Binance.
      let friendly = error.message || 'Failed to sync eligibility criteria to Binance';
      if (/187040|-9000/.test(String(error.message))) {
        friendly =
          "Binance is not allowing this ad to be updated right now (error 187040). " +
          "This is a Binance-side restriction on this specific ad — not your settings. " +
          "Try editing the ad directly in the Binance app; if that also fails, the ad may be " +
          "under review/locked — create a new ad and set the criteria there.";
      }
      res.status(500).json({ success: false, error: friendly });
    }
  }
}

module.exports = new SellerAdsController();
