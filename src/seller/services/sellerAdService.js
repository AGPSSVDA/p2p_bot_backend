const logger = require('../../utils/logger');
const sellerOrderDbService = require('./sellerOrderDbService');

/**
 * Seller Ad Service
 * Manages seller ad configurations and rules
 */
class SellerAdService {

  /**
   * Get all ads for a seller (with their rules)
   */
  async getSellerAds(sellerId, isActive = true) {
    try {
      const ads = await sellerOrderDbService.getAdsBySellerAndStatus(sellerId, isActive);

      // Enrich each ad with its rules and trade methods
      const enrichedAds = await Promise.all(
        ads.map(async (ad) => {
          const rules = await sellerOrderDbService.getAdRules(ad.ad_no);
          const tradeMethods = await sellerOrderDbService.getAdTradeMethods(ad.ad_no);
          return {
            ...ad,
            rules: rules || {},
            tradeMethods: tradeMethods || []
          };
        })
      );

      return enrichedAds;
    } catch (error) {
      logger.error(`Error fetching seller ads: ${error.message}`);
      return [];
    }
  }

  /**
   * Get specific ad with rules
   */
  async getAdWithRules(adNo) {
    try {
      const ad = await sellerOrderDbService.getAdByNo(adNo);
      if (!ad) return null;

      const rules = await sellerOrderDbService.getAdRules(adNo);
      const tradeMethods = await sellerOrderDbService.getAdTradeMethods(adNo);

      return {
        ...ad,
        rules: rules || {},
        tradeMethods: tradeMethods || []
      };
    } catch (error) {
      logger.error(`Error fetching ad ${adNo}: ${error.message}`);
      return null;
    }
  }

  /**
   * Create or update ad rules
   * Call this when seller configures an ad from dashboard
   */
  async updateAdRules(sellerId, adNo, rulesData) {
    try {
      logger.info(`Updating ad rules`, { sellerId, adNo });

      await sellerOrderDbService.upsertAdRules(sellerId, adNo, {
        // Buyer Eligibility (11 fields)
        min_30day_trades: rulesData.min_30day_trades || 0,
        min_30day_completion_rate: rulesData.min_30day_completion_rate || 0,
        max_avg_release_time: rulesData.max_avg_release_time || 0,
        max_avg_pay_time: rulesData.max_avg_pay_time || 0,
        required_trade_type: rulesData.required_trade_type || 'ANY',
        min_registered_days: rulesData.min_registered_days || 0,
        min_first_trade_days: rulesData.min_first_trade_days || 0,
        min_trading_counterparty: rulesData.min_trading_counterparty || 0,
        min_all_trades_count: rulesData.min_all_trades_count || 0,
        min_buy_orders_count: rulesData.min_buy_orders_count || 0,
        min_sell_orders_count: rulesData.min_sell_orders_count || 0,

        // Verification Methods (Toggles)
        method1_liveness_enabled: rulesData.method1_liveness_enabled || false,
        method2_documents_enabled: rulesData.method2_documents_enabled || false,
        method2_mobile_verification_enabled: rulesData.method2_mobile_verification_enabled || false,
        method3_full_enabled: rulesData.method3_full_enabled || false,
        method3_mobile_verification_enabled: rulesData.method3_mobile_verification_enabled || false,
        method3_payment_link_enabled: rulesData.method3_payment_link_enabled || false,
        method3_payment_gateway: rulesData.method3_payment_gateway || 'razorpay',
        method3_delivery_method: rulesData.method3_delivery_method || 'payment_link'
      });

      logger.info(`✅ Ad rules updated`, { sellerId, adNo });
      return { success: true };

    } catch (error) {
      logger.error(`Error updating ad rules: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Validate rules data
   * Check if at least one method is enabled
   */
  validateRules(rulesData) {
    const errors = [];

    const hasAnyMethod =
      rulesData.method1_liveness_enabled ||
      rulesData.method2_documents_enabled ||
      rulesData.method3_full_enabled;

    if (!hasAnyMethod) {
      errors.push('At least one verification method must be enabled');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get rule summary for logging/display
   */
  getRuleSummary(rules) {
    const methods = [];

    if (rules.method1_liveness_enabled) methods.push('Liveness');
    if (rules.method2_documents_enabled) methods.push('Documents');
    if (rules.method3_full_enabled) methods.push('Full');

    return {
      methods: methods.join(' + '),
      minTradesCount: rules.min_30day_trades,
      minCompletionRate: rules.min_30day_completion_rate,
      minRegisteredDays: rules.min_registered_days
    };
  }
}

module.exports = new SellerAdService();
