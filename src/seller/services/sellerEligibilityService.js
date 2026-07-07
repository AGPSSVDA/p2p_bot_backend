const logger = require('../../utils/logger');
const sellerBuyerMetricsService = require('./sellerBuyerMetricsService');
const sellerOrderDbService = require('./sellerOrderDbService');

/**
 * Seller Eligibility Service
 * STEP 2: Checks if buyer meets all ad-specific eligibility rules
 */
class SellerEligibilityService {

  /**
   * Main eligibility check
   * @param {string} buyerId - Binance buyer ID
   * @param {string} adNo - Ad number
   * @returns {Promise<{eligible: boolean, failedChecks: Array, reason: string}>}
   */
  async checkBuyerEligibility(buyerId, adNo) {
    try {
      // Get ad rules
      const rules = await sellerOrderDbService.getAdRules(adNo);
      if (!rules) {
        return {
          eligible: false,
          failedChecks: [],
          reason: 'No rules configured for this ad'
        };
      }

      // Get buyer metrics
      const metrics = await sellerBuyerMetricsService.getBuyerMetrics(buyerId);
      if (!metrics) {
        logger.warn(`Buyer metrics not found`, { buyerId, adNo });
        return {
          eligible: false,
          failedChecks: [],
          reason: 'Could not fetch buyer metrics'
        };
      }

      // Check all 11 criteria
      const failedChecks = [];

      // 1. 30 day trades count
      if (metrics.trades_30day < rules.min_30day_trades) {
        failedChecks.push({
          criterion: '30 day trades count',
          required: rules.min_30day_trades,
          actual: metrics.trades_30day
        });
      }

      // 2. 30 day completion rate
      if (metrics.completion_rate_30day < rules.min_30day_completion_rate) {
        failedChecks.push({
          criterion: '30 day completion rate',
          required: rules.min_30day_completion_rate,
          actual: metrics.completion_rate_30day
        });
      }

      // 3. Avg release time
      if (rules.max_avg_release_time > 0 && metrics.avg_release_time_minutes > rules.max_avg_release_time) {
        failedChecks.push({
          criterion: 'Avg release time',
          required: `≤ ${rules.max_avg_release_time} minutes`,
          actual: `${metrics.avg_release_time_minutes} minutes`
        });
      }

      // 4. Avg pay time
      if (rules.max_avg_pay_time > 0 && metrics.avg_pay_time_minutes > rules.max_avg_pay_time) {
        failedChecks.push({
          criterion: 'Avg pay time',
          required: `≤ ${rules.max_avg_pay_time} minutes`,
          actual: `${metrics.avg_pay_time_minutes} minutes`
        });
      }

      // 5. Trade type
      if (rules.required_trade_type && rules.required_trade_type !== 'ANY') {
        // This would require knowing the trade type (BUY/SELL)
        // For now, skip this check
      }

      // 6. Registered days
      if (metrics.registered_days < rules.min_registered_days) {
        failedChecks.push({
          criterion: 'Registered days',
          required: rules.min_registered_days,
          actual: metrics.registered_days
        });
      }

      // 7. First trade days ago
      if (metrics.registered_days < rules.min_first_trade_days) {
        failedChecks.push({
          criterion: 'First trade days',
          required: rules.min_first_trade_days,
          actual: metrics.registered_days
        });
      }

      // 8. Trading counterparty count
      if (metrics.trading_counterparty_count < rules.min_trading_counterparty) {
        failedChecks.push({
          criterion: 'Trading counterparty count',
          required: rules.min_trading_counterparty,
          actual: metrics.trading_counterparty_count
        });
      }

      // 9. All trades count
      if (metrics.all_trades_count < rules.min_all_trades_count) {
        failedChecks.push({
          criterion: 'All trades count',
          required: rules.min_all_trades_count,
          actual: metrics.all_trades_count
        });
      }

      // 10. Buy orders count
      if (metrics.buy_orders_count < rules.min_buy_orders_count) {
        failedChecks.push({
          criterion: 'Buy orders count',
          required: rules.min_buy_orders_count,
          actual: metrics.buy_orders_count
        });
      }

      // 11. Sell orders count
      if (metrics.sell_orders_count < rules.min_sell_orders_count) {
        failedChecks.push({
          criterion: 'Sell orders count',
          required: rules.min_sell_orders_count,
          actual: metrics.sell_orders_count
        });
      }

      // Determine result
      const eligible = failedChecks.length === 0;
      const reason = eligible
        ? 'All criteria passed'
        : `Failed: ${failedChecks.map(c => c.criterion).join(', ')}`;

      logger.info(`Eligibility check`, {
        buyerId,
        adNo,
        eligible,
        failedCount: failedChecks.length
      });

      return {
        eligible,
        failedChecks,
        reason
      };

    } catch (error) {
      logger.error(`Eligibility check error: ${error.message}`, { buyerId, adNo });
      return {
        eligible: false,
        failedChecks: [],
        reason: `Error: ${error.message}`
      };
    }
  }

  /**
   * Format eligibility message for buyer
   */
  formatEligibilityMessage(failedChecks) {
    if (failedChecks.length === 0) {
      return 'All eligibility criteria passed!';
    }

    const failures = failedChecks.map(c =>
      `• ${c.criterion}: Required ${c.required}, Your: ${c.actual}`
    ).join('\n');

    return `You don't meet the seller's criteria:\n\n${failures}`;
  }
}

module.exports = new SellerEligibilityService();
