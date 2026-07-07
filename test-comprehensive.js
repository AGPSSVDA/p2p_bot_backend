require('dotenv').config();
const { pool } = require('./src/config/mysql');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');
const sellerOrderDbService = require('./src/seller/services/sellerOrderDbService');

const AD_NO = '13900814235866066944';

async function comprehensiveTest() {
  try {
    console.log('\n' + '█'.repeat(80));
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█' + '  COMPREHENSIVE ELIGIBILITY CHECK TEST FOR AD: 13900814235866066944'.padEnd(78) + '█');
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█'.repeat(80) + '\n');

    // Get all test orders
    const [orders] = await pool.query(
      `SELECT * FROM seller_orders
       WHERE ad_no = ? AND order_number LIKE '%test%' OR order_number LIKE '%failed%'
       ORDER BY created_at DESC`,
      [AD_NO]
    );

    if (orders.length === 0) {
      console.log('📦 No test orders found in database\n');

      // Create them if not exist
      console.log('Creating test orders...\n');

      // Test order 1 - High metrics (should pass)
      await pool.query(
        `INSERT IGNORE INTO seller_buyer_metrics
         (buyer_id, trades_30day, completion_rate_30day, registered_days, trading_counterparty_count,
          all_trades_count, buy_orders_count, sell_orders_count, avg_release_time_minutes, avg_pay_time_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['testbuyer12345', 50, 99.5, 250, 80, 300, 150, 150, 2, 10]
      );

      await pool.query(
        `INSERT IGNORE INTO seller_orders
         (order_number, ad_no, buyer_id, buyer_nickname, fiat_amount, fiat_unit, current_state, order_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['test_order_12345', AD_NO, 'testbuyer12345', 'TestBuyer', 5000, 'INR', 'unpaid', 'pending', new Date()]
      );

      // Test order 2 - Low metrics (should fail)
      await pool.query(
        `INSERT IGNORE INTO seller_buyer_metrics
         (buyer_id, trades_30day, completion_rate_30day, registered_days, trading_counterparty_count,
          all_trades_count, buy_orders_count, sell_orders_count, avg_release_time_minutes, avg_pay_time_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['failedbuyer12345', 5, 85, 30, 10, 20, 5, 5, 20, 30]
      );

      await pool.query(
        `INSERT IGNORE INTO seller_orders
         (order_number, ad_no, buyer_id, buyer_nickname, fiat_amount, fiat_unit, current_state, order_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['failed_order_12345', AD_NO, 'failedbuyer12345', 'FailedBuyer', 1000, 'INR', 'unpaid', 'pending', new Date()]
      );

      console.log('✅ Test orders created\n');
    }

    // Get fresh orders after creation
    const [refreshedOrders] = await pool.query(
      `SELECT * FROM seller_orders
       WHERE ad_no = ? AND (order_number = 'test_order_12345' OR order_number = 'failed_order_12345')
       ORDER BY created_at DESC`,
      [AD_NO]
    );

    // Get AD details
    const [adRows] = await pool.query('SELECT * FROM seller_ads WHERE ad_no = ?', [AD_NO]);
    const ad = adRows[0];

    console.log('📋 AD CONFIGURATION');
    console.log('─'.repeat(80));
    console.log(`   Asset: ${ad.asset}/${ad.fiat_unit}`);
    console.log(`   Classify: ${ad.classify}`);
    console.log(`   Status: ${ad.ad_status === 1 ? '🟢 Online' : '🔴 Offline'}\n`);

    // Get AD rules
    const [rulesRows] = await pool.query('SELECT * FROM seller_ad_rules WHERE ad_no = ?', [AD_NO]);
    const rules = rulesRows[0];

    console.log('📊 ELIGIBILITY REQUIREMENTS');
    console.log('─'.repeat(80));
    console.log(`   Min 30-Day Trades: ${rules.min_30day_trades}`);
    console.log(`   Min Completion Rate: ${rules.min_30day_completion_rate}%`);
    console.log(`   Max Avg Release Time: ${rules.max_avg_release_time} min`);
    console.log(`   Max Avg Pay Time: ${rules.max_avg_pay_time} min`);
    console.log(`   Min Registered Days: ${rules.min_registered_days}`);
    console.log(`   Min Trading Counterparties: ${rules.min_trading_counterparty}`);
    console.log(`   Min All Trades Count: ${rules.min_all_trades_count}`);
    console.log(`   Min Buy Orders: ${rules.min_buy_orders_count}`);
    console.log(`   Min Sell Orders: ${rules.min_sell_orders_count}\n`);

    // Test each order
    for (let i = 0; i < refreshedOrders.length; i++) {
      const order = refreshedOrders[i];

      console.log('\n' + '█'.repeat(80));
      console.log(`TEST CASE ${i + 1}: ${order.order_number.toUpperCase()}`);
      console.log('█'.repeat(80) + '\n');

      console.log(`📦 Order Details:`);
      console.log(`   Order No: ${order.order_number}`);
      console.log(`   Buyer: ${order.buyer_nickname} (ID: ${order.buyer_id})`);
      console.log(`   Amount: ${order.fiat_amount} ${order.fiat_unit}\n`);

      // Get buyer metrics
      const [buyerMetricsRows] = await pool.query(
        'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?',
        [order.buyer_id]
      );
      const buyerMetrics = buyerMetricsRows[0];

      if (!buyerMetrics) {
        console.log('❌ Buyer metrics not found\n');
        continue;
      }

      console.log('📈 Buyer Metrics:');
      console.log(`   30-Day Trades: ${buyerMetrics.trades_30day} (required: ${rules.min_30day_trades})`);
      console.log(`   Completion Rate: ${buyerMetrics.completion_rate_30day}% (required: ${rules.min_30day_completion_rate}%)`);
      console.log(`   Avg Release Time: ${buyerMetrics.avg_release_time_minutes} min (max: ${rules.max_avg_release_time} min)`);
      console.log(`   Avg Pay Time: ${buyerMetrics.avg_pay_time_minutes} min (max: ${rules.max_avg_pay_time} min)`);
      console.log(`   Registered Days: ${buyerMetrics.registered_days} (required: ${rules.min_registered_days})`);
      console.log(`   Trading Counterparties: ${buyerMetrics.trading_counterparty_count} (required: ${rules.min_trading_counterparty})`);
      console.log(`   All Trades Count: ${buyerMetrics.all_trades_count} (required: ${rules.min_all_trades_count})`);
      console.log(`   Buy Orders: ${buyerMetrics.buy_orders_count} (required: ${rules.min_buy_orders_count})`);
      console.log(`   Sell Orders: ${buyerMetrics.sell_orders_count} (required: ${rules.min_sell_orders_count})\n`);

      // Check eligibility
      const eligibility = await sellerEligibilityService.checkBuyerEligibility(order.buyer_id, AD_NO);

      console.log('🎯 ELIGIBILITY CHECK RESULT:');
      console.log('─'.repeat(80));

      if (eligibility.eligible) {
        console.log('🟢 ✅ ELIGIBILITY PASSED!\n');
      } else {
        console.log('🔴 ❌ ELIGIBILITY FAILED!\n');

        if (eligibility.failedChecks && eligibility.failedChecks.length > 0) {
          console.log(`Failed ${eligibility.failedChecks.length} criteria:\n`);
          eligibility.failedChecks.forEach((check, idx) => {
            console.log(`   ${idx + 1}. ${check.criterion}`);
            console.log(`      Required: ${check.required}, Actual: ${check.actual}`);
          });
        }
        console.log();
      }
    }

    console.log('\n' + '█'.repeat(80));
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█' + '  ✅ COMPREHENSIVE TEST COMPLETED'.padEnd(78) + '█');
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█'.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

comprehensiveTest();
