require('dotenv').config();
const binanceService = require('./src/services/binanceService');
const sellerOrderDbService = require('./src/seller/services/sellerOrderDbService');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');
const logger = require('./src/utils/logger');

const AD_NO = '13900814235866066944';

async function testEligibilityCheck() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 ELIGIBILITY CHECK TEST FOR AD: ' + AD_NO);
    console.log('='.repeat(80) + '\n');

    // Step 1: Get orders from Binance for this ad
    console.log('📡 Step 1: Fetching orders from Binance...\n');
    const allOrders = await binanceService.getPendingOrders();

    if (!allOrders || allOrders.length === 0) {
      console.log('❌ No orders found from Binance\n');
      return;
    }

    console.log(`✅ Found ${allOrders.length} total orders from Binance\n`);

    // Step 2: Filter orders for this specific ad
    console.log(`🔎 Step 2: Filtering orders for AD ${AD_NO}...\n`);
    const adOrders = allOrders.filter(o => o.adOrderNo === AD_NO);

    if (adOrders.length === 0) {
      console.log(`❌ No orders found for AD ${AD_NO}\n`);
      console.log('Orders found for these ads:');
      const uniqueAds = [...new Set(allOrders.map(o => o.adOrderNo))];
      uniqueAds.forEach(ad => console.log(`  - ${ad}`));
      console.log();
      return;
    }

    console.log(`✅ Found ${adOrders.length} order(s) for AD ${AD_NO}\n`);

    // Step 3: Get ad details and rules
    console.log('📋 Step 3: Fetching AD details and eligibility rules...\n');
    const [adRows] = await require('./src/config/mysql').pool.query(
      'SELECT * FROM seller_ads WHERE ad_no = ?',
      [AD_NO]
    );
    const ad = adRows[0];

    const [rulesRows] = await require('./src/config/mysql').pool.query(
      'SELECT * FROM seller_ad_rules WHERE ad_no = ?',
      [AD_NO]
    );
    const rules = rulesRows[0];

    if (!ad) {
      console.log('❌ AD not found in database\n');
      return;
    }

    if (!rules) {
      console.log('❌ No eligibility rules configured for this AD\n');
      return;
    }

    console.log('✅ AD found:');
    console.log(`   Asset: ${ad.asset}/${ad.fiat_unit}`);
    console.log(`   Classify: ${ad.classify}`);
    console.log(`   Status: ${ad.ad_status === 1 ? 'Online' : ad.ad_status === 3 ? 'Offline' : 'Closed'}\n`);

    // Step 4: Check eligibility for each order/buyer
    console.log('🎯 Step 4: Checking buyer eligibility for each order...\n');

    for (let i = 0; i < adOrders.length; i++) {
      const order = adOrders[i];
      console.log(`\n${'-'.repeat(80)}`);
      console.log(`📦 ORDER ${i + 1}/${adOrders.length}`);
      console.log(`${'-'.repeat(80)}\n`);

      console.log(`Order No: ${order.orderNumber}`);
      console.log(`Buyer: ${order.counterPartNickName}`);
      console.log(`Buyer ID: ${order.counterPartUserId}`);
      console.log(`Amount: ${order.totalPrice} ${order.fiat}\n`);

      // Get buyer metrics from database (if exists)
      const [metricsRows] = await require('./src/config/mysql').pool.query(
        'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?',
        [order.counterPartUserId]
      );
      const buyerMetrics = metricsRows[0];

      if (!buyerMetrics) {
        console.log('⚠️  Buyer metrics not found in database\n');
        continue;
      }

      // Check eligibility
      const eligibility = await sellerEligibilityService.checkBuyerEligibility(
        order.counterPartUserId,
        AD_NO
      );

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

      console.log('✅ Eligibility Requirements:');
      console.log(`   Min 30-Day Trades: ${rules.min_30day_trades}`);
      console.log(`   Min Completion Rate: ${rules.min_30day_completion_rate}%`);
      console.log(`   Max Avg Release Time: ${rules.max_avg_release_time > 0 ? rules.max_avg_release_time : 'None'} min`);
      console.log(`   Max Avg Pay Time: ${rules.max_avg_pay_time > 0 ? rules.max_avg_pay_time : 'None'} min`);
      console.log(`   Min Registered Days: ${rules.min_registered_days}`);
      console.log(`   Min Trading Counterparties: ${rules.min_trading_counterparty}`);
      console.log(`   Min All Trades Count: ${rules.min_all_trades_count}`);
      console.log(`   Min Buy Orders: ${rules.min_buy_orders_count}`);
      console.log(`   Min Sell Orders: ${rules.min_sell_orders_count}\n`);

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
    console.log('✅ Test completed!');
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
