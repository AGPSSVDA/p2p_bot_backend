const logger = require('../../utils/logger');
const sellerOrderDbService = require('./sellerOrderDbService');

/**
 * Seller Buyer Metrics Service
 * Fetches and caches buyer metrics from Binance
 * Used for Step 2: Eligibility Check
 */
class SellerBuyerMetricsService {

  constructor() {
    this.metricsCache = {};
    this.cacheTTL = 3600000; // 1 hour cache
  }

  /**
   * Get buyer metrics
   * First check cache, then DB, then return null
   */
  async getBuyerMetrics(buyerId) {
    try {
      // Check cache
      if (this.isCacheValid(buyerId)) {
        logger.debug(`Buyer metrics from cache`, { buyerId });
        return this.metricsCache[buyerId].data;
      }

      // Check database
      const dbMetrics = await sellerOrderDbService.getBuyerMetrics(buyerId);
      if (dbMetrics) {
        this.setCacheEntry(buyerId, dbMetrics);
        return dbMetrics;
      }

      // Not found
      logger.warn(`Buyer metrics not found in DB`, { buyerId });
      return null;

    } catch (error) {
      logger.error(`Error getting buyer metrics: ${error.message}`, { buyerId });
      return null;
    }
  }

  /**
   * Store buyer metrics in database
   * Called after fetching from Binance (or external source)
   */
  async storeBuyerMetrics(buyerId, metricsData) {
    try {
      logger.debug(`Storing buyer metrics`, { buyerId });

      await sellerOrderDbService.upsertBuyerMetrics(buyerId, {
        trades_30day: metricsData.trades_30day || 0,
        completion_rate_30day: metricsData.completion_rate_30day || 0,
        avg_release_time_minutes: metricsData.avg_release_time_minutes || 0,
        avg_pay_time_minutes: metricsData.avg_pay_time_minutes || 0,
        registered_days: metricsData.registered_days || 0,
        first_trade_date: metricsData.first_trade_date || null,
        trading_counterparty_count: metricsData.trading_counterparty_count || 0,
        all_trades_count: metricsData.all_trades_count || 0,
        buy_orders_count: metricsData.buy_orders_count || 0,
        sell_orders_count: metricsData.sell_orders_count || 0
      });

      // Update cache
      this.setCacheEntry(buyerId, metricsData);

      logger.debug(`✅ Buyer metrics stored`, { buyerId });

    } catch (error) {
      logger.error(`Error storing buyer metrics: ${error.message}`, { buyerId });
    }
  }

  /**
   * Create mock metrics for testing
   * In production, these would come from Binance API or external source
   */
  createMockMetrics(buyerId, overrides = {}) {
    return {
      buyerId,
      trades_30day: overrides.trades_30day || 10,
      completion_rate_30day: overrides.completion_rate_30day || 95.5,
      avg_release_time_minutes: overrides.avg_release_time_minutes || 12,
      avg_pay_time_minutes: overrides.avg_pay_time_minutes || 8,
      registered_days: overrides.registered_days || 45,
      first_trade_date: overrides.first_trade_date || new Date(Date.now() - 45 * 86400000),
      trading_counterparty_count: overrides.trading_counterparty_count || 15,
      all_trades_count: overrides.all_trades_count || 150,
      buy_orders_count: overrides.buy_orders_count || 75,
      sell_orders_count: overrides.sell_orders_count || 75
    };
  }

  // ===== PRIVATE METHODS =====

  isCacheValid(buyerId) {
    if (!this.metricsCache[buyerId]) return false;

    const now = Date.now();
    const cachedAt = this.metricsCache[buyerId].cachedAt;
    const age = now - cachedAt;

    return age < this.cacheTTL;
  }

  setCacheEntry(buyerId, data) {
    this.metricsCache[buyerId] = {
      data,
      cachedAt: Date.now()
    };
  }

  clearCache() {
    this.metricsCache = {};
  }
}

module.exports = new SellerBuyerMetricsService();
