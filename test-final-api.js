require('dotenv').config();
const { pool } = require('./src/config/mysql');

const ORDER_NO = 'test_order_12345';

async function testFinalAPI() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 FINAL API RESPONSE TEST');
    console.log('='.repeat(80) + '\n');

    console.log(`Testing: GET /api/seller/orders/${ORDER_NO}/eligibility-check\n`);

    // Simulate what the API endpoint does
    const [orderRows] = await pool.query(
      'SELECT * FROM seller_orders WHERE order_number = ?',
      [ORDER_NO]
    );

    if (orderRows.length === 0) {
      const errorResponse = {
        success: false,
        error: 'Order not found'
      };
      console.log('❌ 404 Response:');
      console.log(JSON.stringify(errorResponse, null, 2));
      process.exit(0);
    }

    const order = orderRows[0];

    // Get ad details
    const [adRows] = await pool.query(
      'SELECT * FROM seller_ads WHERE ad_no = ?',
      [order.ad_no]
    );
    const ad = adRows[0];

    // Get ad rules
    const [rulesRows] = await pool.query(
      'SELECT * FROM seller_ad_rules WHERE ad_no = ?',
      [order.ad_no]
    );
    const rules = rulesRows[0];

    // Get buyer metrics
    const [buyerMetricsRows] = await pool.query(
      'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?',
      [order.buyer_id]
    );
    const buyerMetrics = buyerMetricsRows[0];

    // Build criteria (same logic as API)
    const criteria = [];
    if (rules && buyerMetrics) {
      const checks = [
        { name: '30-Day Trades', required: rules.min_30day_trades, actual: buyerMetrics.trades_30day },
        { name: 'Completion Rate (%)', required: rules.min_30day_completion_rate, actual: buyerMetrics.completion_rate_30day },
        { name: 'Max Avg Release Time (min)', required: rules.max_avg_release_time > 0 ? rules.max_avg_release_time : 'None', actual: buyerMetrics.avg_release_time_minutes },
        { name: 'Max Avg Pay Time (min)', required: rules.max_avg_pay_time > 0 ? rules.max_avg_pay_time : 'None', actual: buyerMetrics.avg_pay_time_minutes },
        { name: 'Min Registered Days', required: rules.min_registered_days, actual: buyerMetrics.registered_days },
        { name: 'Min Trading Counterparties', required: rules.min_trading_counterparty, actual: buyerMetrics.trading_counterparty_count },
        { name: 'Min All Trades Count', required: rules.min_all_trades_count, actual: buyerMetrics.all_trades_count },
        { name: 'Min Buy Orders Count', required: rules.min_buy_orders_count, actual: buyerMetrics.buy_orders_count },
        { name: 'Min Sell Orders Count', required: rules.min_sell_orders_count, actual: buyerMetrics.sell_orders_count },
        { name: 'Min First Trade Days', required: rules.min_first_trade_days, actual: buyerMetrics.registered_days }
      ];

      checks.forEach(check => {
        let passed;
        if (typeof check.required === 'string' || (typeof check.required === 'number' && check.required === 0)) {
          passed = true;
        } else if (check.name.includes('Max')) {
          passed = check.actual <= check.required;
        } else {
          passed = check.actual >= check.required;
        }

        criteria.push({
          criterion: check.name,
          required: check.required,
          actual: check.actual,
          passed
        });
      });
    }

    // Final API response
    const apiResponse = {
      success: true,
      data: {
        orderNo: order.order_number,
        buyer: {
          id: order.buyer_id,
          nickname: order.buyer_nickname,
          kycName: order.buyer_kyc_name
        },
        ad: {
          adNo: order.ad_no,
          asset: ad?.asset,
          fiatUnit: ad?.fiat_unit,
          classify: ad?.classify
        },
        eligibility: {
          checkCompleted: !!order.eligibility_check_completed_at,
          passed: order.eligibility_check_passed === 1,
          failedReason: order.eligibility_check_failed_reason,
          checkedAt: order.eligibility_check_completed_at
        },
        criteria,
        buyerMetrics: buyerMetrics ? {
          trades30Day: buyerMetrics.trades_30day,
          completionRate: buyerMetrics.completion_rate_30day,
          avgReleaseTime: buyerMetrics.avg_release_time_minutes,
          avgPayTime: buyerMetrics.avg_pay_time_minutes,
          registeredDays: buyerMetrics.registered_days,
          tradingCounterparties: buyerMetrics.trading_counterparty_count,
          allTradesCount: buyerMetrics.all_trades_count,
          buyOrdersCount: buyerMetrics.buy_orders_count,
          sellOrdersCount: buyerMetrics.sell_orders_count
        } : null
      }
    };

    console.log('✅ 200 Response:\n');
    console.log(JSON.stringify(apiResponse, null, 2));

    const passedCount = criteria.filter(c => c.passed).length;
    console.log('\n' + '='.repeat(80));
    console.log(`📊 Eligibility Summary: ${passedCount}/${criteria.length} criteria passed`);
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    process.exit(0);
  }
}

testFinalAPI();
