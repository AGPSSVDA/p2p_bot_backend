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
   * IMPORTANT: Only update fields that are explicitly provided
   * Preserve existing values for fields not in rulesData
   */
  async updateAdRules(sellerId, adNo, rulesData) {
    try {
      logger.info(`Updating ad rules`, { sellerId, adNo });

      // Get existing rules first to preserve fields not being updated
      const existingRules = await sellerOrderDbService.getAdRules(adNo);

      // Build update object - only include fields that are explicitly provided
      // If a field is not provided, use existing value (preserve it)
      const updateData = {
        // Buyer Eligibility Criteria (11 fields) - with enabled toggles
        min_30day_trades_enabled: rulesData.min_30day_trades_enabled !== undefined
          ? rulesData.min_30day_trades_enabled === true
          : (existingRules?.min_30day_trades_enabled === 1 || existingRules?.min_30day_trades_enabled === true),
        min_30day_trades: rulesData.min_30day_trades !== undefined ? rulesData.min_30day_trades : (existingRules?.min_30day_trades || 0),

        min_30day_completion_rate_enabled: rulesData.min_30day_completion_rate_enabled !== undefined
          ? rulesData.min_30day_completion_rate_enabled === true
          : (existingRules?.min_30day_completion_rate_enabled === 1 || existingRules?.min_30day_completion_rate_enabled === true),
        // Frontend sends a 0-100 percentage; store as the 0-1 decimal Binance uses.
        min_30day_completion_rate: rulesData.min_30day_completion_rate !== undefined
          ? Math.min(100, Math.max(0, rulesData.min_30day_completion_rate)) / 100
          : (existingRules?.min_30day_completion_rate || 0),

        max_avg_release_time_enabled: rulesData.max_avg_release_time_enabled !== undefined
          ? rulesData.max_avg_release_time_enabled === true
          : (existingRules?.max_avg_release_time_enabled === 1 || existingRules?.max_avg_release_time_enabled === true),
        max_avg_release_time: rulesData.max_avg_release_time !== undefined ? rulesData.max_avg_release_time : (existingRules?.max_avg_release_time || 0),

        max_avg_pay_time_enabled: rulesData.max_avg_pay_time_enabled !== undefined
          ? rulesData.max_avg_pay_time_enabled === true
          : (existingRules?.max_avg_pay_time_enabled === 1 || existingRules?.max_avg_pay_time_enabled === true),
        max_avg_pay_time: rulesData.max_avg_pay_time !== undefined ? rulesData.max_avg_pay_time : (existingRules?.max_avg_pay_time || 0),

        required_trade_type_enabled: rulesData.required_trade_type_enabled !== undefined
          ? rulesData.required_trade_type_enabled === true
          : (existingRules?.required_trade_type_enabled === 1 || existingRules?.required_trade_type_enabled === true),
        required_trade_type: rulesData.required_trade_type !== undefined ? rulesData.required_trade_type : (existingRules?.required_trade_type || 'ANY'),

        min_registered_days_enabled: rulesData.min_registered_days_enabled !== undefined
          ? rulesData.min_registered_days_enabled === true
          : (existingRules?.min_registered_days_enabled === 1 || existingRules?.min_registered_days_enabled === true),
        min_registered_days: rulesData.min_registered_days !== undefined ? rulesData.min_registered_days : (existingRules?.min_registered_days || 0),

        min_first_trade_days_enabled: rulesData.min_first_trade_days_enabled !== undefined
          ? rulesData.min_first_trade_days_enabled === true
          : (existingRules?.min_first_trade_days_enabled === 1 || existingRules?.min_first_trade_days_enabled === true),
        min_first_trade_days: rulesData.min_first_trade_days !== undefined ? rulesData.min_first_trade_days : (existingRules?.min_first_trade_days || 0),

        min_trading_counterparty_enabled: rulesData.min_trading_counterparty_enabled !== undefined
          ? rulesData.min_trading_counterparty_enabled === true
          : (existingRules?.min_trading_counterparty_enabled === 1 || existingRules?.min_trading_counterparty_enabled === true),
        min_trading_counterparty: rulesData.min_trading_counterparty !== undefined ? rulesData.min_trading_counterparty : (existingRules?.min_trading_counterparty || 0),

        min_all_trades_count_enabled: rulesData.min_all_trades_count_enabled !== undefined
          ? rulesData.min_all_trades_count_enabled === true
          : (existingRules?.min_all_trades_count_enabled === 1 || existingRules?.min_all_trades_count_enabled === true),
        min_all_trades_count: rulesData.min_all_trades_count !== undefined ? rulesData.min_all_trades_count : (existingRules?.min_all_trades_count || 0),

        min_buy_orders_count_enabled: rulesData.min_buy_orders_count_enabled !== undefined
          ? rulesData.min_buy_orders_count_enabled === true
          : (existingRules?.min_buy_orders_count_enabled === 1 || existingRules?.min_buy_orders_count_enabled === true),
        min_buy_orders_count: rulesData.min_buy_orders_count !== undefined ? rulesData.min_buy_orders_count : (existingRules?.min_buy_orders_count || 0),

        min_sell_orders_count_enabled: rulesData.min_sell_orders_count_enabled !== undefined
          ? rulesData.min_sell_orders_count_enabled === true
          : (existingRules?.min_sell_orders_count_enabled === 1 || existingRules?.min_sell_orders_count_enabled === true),
        min_sell_orders_count: rulesData.min_sell_orders_count !== undefined ? rulesData.min_sell_orders_count : (existingRules?.min_sell_orders_count || 0),

        // Verification Methods (Toggles) - PRESERVE if not provided
        method1_liveness_enabled: rulesData.method1_liveness_enabled !== undefined
          ? rulesData.method1_liveness_enabled === true
          : (existingRules?.method1_liveness_enabled === 1 || existingRules?.method1_liveness_enabled === true),
        method1_mobile_verification_enabled: rulesData.method1_mobile_verification_enabled !== undefined
          ? rulesData.method1_mobile_verification_enabled === true
          : (existingRules?.method1_mobile_verification_enabled === 1 || existingRules?.method1_mobile_verification_enabled === true),
        method2_documents_enabled: rulesData.method2_documents_enabled !== undefined
          ? rulesData.method2_documents_enabled === true
          : (existingRules?.method2_documents_enabled === 1 || existingRules?.method2_documents_enabled === true),
        method2_mobile_verification_enabled: rulesData.method2_mobile_verification_enabled !== undefined
          ? rulesData.method2_mobile_verification_enabled === true
          : (existingRules?.method2_mobile_verification_enabled === 1 || existingRules?.method2_mobile_verification_enabled === true),
        method3_full_enabled: rulesData.method3_full_enabled !== undefined
          ? rulesData.method3_full_enabled === true
          : (existingRules?.method3_full_enabled === 1 || existingRules?.method3_full_enabled === true),
        method3_mobile_verification_enabled: rulesData.method3_mobile_verification_enabled !== undefined
          ? rulesData.method3_mobile_verification_enabled === true
          : (existingRules?.method3_mobile_verification_enabled === 1 || existingRules?.method3_mobile_verification_enabled === true),
        method3_payment_link_enabled: rulesData.method3_payment_link_enabled !== undefined
          ? rulesData.method3_payment_link_enabled === true
          : (existingRules?.method3_payment_link_enabled === 1 || existingRules?.method3_payment_link_enabled === true),
        method3_payment_gateway: rulesData.method3_payment_gateway || existingRules?.method3_payment_gateway || 'easebuzz',
        method3_delivery_method: rulesData.method3_delivery_method || existingRules?.method3_delivery_method || 'payment_link',
        // Per-ad re-order cooldown (default OFF; hours default 24 when enabled).
        reorder_cooldown_enabled: rulesData.reorder_cooldown_enabled !== undefined
          ? rulesData.reorder_cooldown_enabled === true
          : (existingRules?.reorder_cooldown_enabled === 1 || existingRules?.reorder_cooldown_enabled === true),
        reorder_cooldown_hours: rulesData.reorder_cooldown_hours !== undefined && Number(rulesData.reorder_cooldown_hours) > 0
          ? Math.round(Number(rulesData.reorder_cooldown_hours))
          : (existingRules?.reorder_cooldown_hours || 24)
      };

      await sellerOrderDbService.upsertAdRules(sellerId, adNo, updateData);

      logger.info(`✅ Ad rules updated`, { sellerId, adNo, updated: Object.keys(rulesData) });
      return { success: true };

    } catch (error) {
      logger.error(`Error updating ad rules: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update ONLY the verification methods for an ad (no Binance call).
   *
   * Methods control bot behaviour after an order arrives (liveness / documents /
   * full verification). Binance has no concept of them, so this is DB-only and
   * stays independent of the eligibility sync.
   */
  async updateAdMethods(sellerId, adNo, methods) {
    try {
      const updated = await sellerOrderDbService.updateAdMethods(sellerId, adNo, methods);

      if (!updated) {
        return { success: false, error: 'No rules row found for this ad' };
      }

      logger.info(`✅ Ad methods updated`, { sellerId, adNo });
      return { success: true };

    } catch (error) {
      logger.error(`Error updating ad methods: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Validate rules data.
   * Verification methods are optional — admin may enable any, all, or none.
   */
  validateRules(_rulesData) {
    return { valid: true, errors: [] };
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
