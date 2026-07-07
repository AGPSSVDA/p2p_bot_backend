require('dotenv').config();
const sellerOrderDbService = require('./src/seller/services/sellerOrderDbService');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');
const sellerBuyerMetricsService = require('./src/seller/services/sellerBuyerMetricsService');

const AD_NO = '13900814235866066944';

async function testEligibilityCheck() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 ELIGIBILITY CHECK TEST FOR AD: ' + AD_NO);
    console.log('='.repeat(80) + '\n');

    // Step 1: Get ad details
    console.log('📋 Step 1: Fetching AD details...\n');
    const ad = await sellerOrderDbService.getAdByNo(AD_NO);

    if (!ad) {
      console.log('❌ AD not found in database\n');
      process.exit(1);
    }

    console.log('✅ AD found:');
    console.log(`   Asset: ${ad.asset}/${ad.fiat_unit}`);
    console.log(`   Classify: ${ad.classify}`);
    console.log(`   Status: ${ad.ad_status === 1 ? 'Online' : ad.ad_status === 3 ? 'Offline' : 'Closed'}\n`);

    // Step 2: Get ad rules
    console.log('✅ Step 2: Fetching eligibility rules...\n');
    const rules = await sellerOrderDbService.getAdRules(AD_NO);

    if (!rules) {
      console.log('❌ No eligibility rules configured for this AD\n');
      process.exit(1);
    }

    console.log('✅ Eligibility Requirements:');
    console.log(`   Min 30-Day Trades: ${rules.min_30day_trades}`);
    console.log(`   Min Completion Rate: ${rules.min_30day_completion_rate}%`);
    console.log(`   Max Avg Release Time: ${rules.max_avg_release_time > 0 ? rules.max_avg_release_time : 'None'} min`);
    console.log(`   Max Avg Pay Time: ${rules.max_avg_pay_time > 0 ? rules.max_avg_pay_time : 'None'} min`);
    console.log(`   Min Registered Days: ${rules.min_registered_days}`);
    console.log(`   Min Trading Counterparties: ${rules.min_trading_counterparty}`);
    console.log(`   Min All Trades Count: ${rules.min_all_trades_count}`);
    console.log(`   Min Buy Orders: ${rules.min_buy_orders_count}`);
    console.log(`   Min Sell Orders: ${rules.min_sell_orders_count}`);
    console.log(`   Required Trade Type: ${rules.required_trade_type}\n`);

    // Step 3: Check if there are any buyers/orders in database for this ad
    console.log('🔎 Step 3: Checking for orders in database...\n');
    const { pool } = require('./src/config/mysql');

    const [orders] = await pool.query(
      'SELECT DISTINCT buyer_id, buyer_nickname FROM seller_orders WHERE ad_no = ? LIMIT 5',
      [AD_NO]
    );

    if (orders.length === 0) {
      console.log('⚠️  No orders found in database for this AD yet.\n');
      console.log('The polling system will detect orders when buyers place them on Binance.');
      console.log('Once an order is placed, the eligibility check will run automatically.\n');
      process.exit(0);
    }

    console.log(`✅ Found ${orders.length} buyer(s) who placed orders on this AD\n`);

    // Step 4: Check eligibility for each buyer
    console.log('🎯 Step 4: Checking buyer eligibility...\n');

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      console.log(`\n${'-'.repeat(80)}`);
      console.log(`👤 BUYER ${i + 1}/${orders.length}`);
      console.log(`${'-'.repeat(80)}\n`);

      console.log(`Buyer Nickname: ${order.buyer_nickname}`);
      console.log(`Buyer ID: ${order.buyer_id}\n`);

      // Get buyer metrics from database
      const buyerMetrics = await sellerOrderDbService.getBuyerMetrics(order.buyer_id);

      if (!buyerMetrics) {
        console.log('⚠️  Buyer metrics not found in database\n');
        continue;
      }

      console.log('📊 Buyer Metrics:');
      console.log(`   30-Day Trades: ${buyerMetrics.trades_30day}`);
      console.log(`   Completion Rate: ${buyerMetrics.completion_rate_30day}%`);
      console.log(`   Registered Days: ${buyerMetrics.registered_days}`);
      console.log(`   Trading Counterparties: ${buyerMetrics.trading_counterparty_count}`);
      console.log(`   All Trades Count: ${buyerMetrics.all_trades_count}`);
      console.log(`   Buy Orders: ${buyerMetrics.buy_orders_count}`);
      console.log(`   Sell Orders: ${buyerMetrics.sell_orders_count}`);
      console.log(`   Avg Release Time: ${buyerMetrics.avg_release_time_minutes} min`);
      console.log(`   Avg Pay Time: ${buyerMetrics.avg_pay_time_minutes} min\n`);

      // Check eligibility
      const eligibility = await sellerEligibilityService.checkBuyerEligibility(
        order.buyer_id,
        AD_NO
      );

      // Show results
      if (eligibility.eligible) {
        console.log('🟢 ✅ ELIGIBILITY PASSED!\n');
      } else {
        console.log('🔴 ❌ ELIGIBILITY FAILED!\n');
        console.log('Failed Criteria:');
        eligibility.failedChecks.forEach(check => {
          console.log(`   ❌ ${check.criterion}`);
          console.log(`      Required: ${check.required}, Actual: ${check.actual}`);
        });
        console.log();
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Eligibility check completed!');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

// Run the test
testEligibilityCheck();
