require('dotenv').config();
const { pool } = require('./src/config/mysql');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');
const sellerOrderDbService = require('./src/seller/services/sellerOrderDbService');

const AD_NO = '13900814235866066944';
const BUYER_ID = 'failedbuyer12345';
const ORDER_NO = 'failed_order_12345';

async function createFailedOrderAndTest() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔨 CREATING FAILED ELIGIBILITY TEST CASE');
    console.log('='.repeat(80) + '\n');

    // Step 1: Create buyer with LOW metrics (will fail eligibility)
    console.log('Step 1: Creating buyer with LOW metrics...\n');
    const buyerMetrics = {
      buyer_id: BUYER_ID,
      trades_30day: 5,  // LOW - FAIL (needs 20)
      completion_rate_30day: 85, // LOW - FAIL (needs 98%)
      registered_days: 30, // LOW - FAIL (needs 100)
      trading_counterparty_count: 10, // LOW - FAIL (needs 50)
      all_trades_count: 20, // LOW - FAIL (needs 100)
      buy_orders_count: 5, // LOW - FAIL (needs 75)
      sell_orders_count: 5, // LOW - FAIL (needs 25)
      avg_release_time_minutes: 20, // HIGH - FAIL (max 3)
      avg_pay_time_minutes: 30, // HIGH - FAIL (max 15)
    };

    // Insert buyer metrics
    const [result] = await pool.query(
      `INSERT INTO seller_buyer_metrics
       (buyer_id, trades_30day, completion_rate_30day, registered_days, trading_counterparty_count,
        all_trades_count, buy_orders_count, sell_orders_count, avg_release_time_minutes, avg_pay_time_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       trades_30day=VALUES(trades_30day),
       completion_rate_30day=VALUES(completion_rate_30day),
       registered_days=VALUES(registered_days),
       trading_counterparty_count=VALUES(trading_counterparty_count),
       all_trades_count=VALUES(all_trades_count),
       buy_orders_count=VALUES(buy_orders_count),
       sell_orders_count=VALUES(sell_orders_count),
       avg_release_time_minutes=VALUES(avg_release_time_minutes),
       avg_pay_time_minutes=VALUES(avg_pay_time_minutes)`,
      [
        buyerMetrics.buyer_id,
        buyerMetrics.trades_30day,
        buyerMetrics.completion_rate_30day,
        buyerMetrics.registered_days,
        buyerMetrics.trading_counterparty_count,
        buyerMetrics.all_trades_count,
        buyerMetrics.buy_orders_count,
        buyerMetrics.sell_orders_count,
        buyerMetrics.avg_release_time_minutes,
        buyerMetrics.avg_pay_time_minutes,
      ]
    );

    console.log('✅ Low-metric buyer created\n');

    // Step 2: Create mock order
    console.log('Step 2: Creating mock seller order...\n');
    const now = new Date();
    const [orderResult] = await pool.query(
      `INSERT INTO seller_orders
       (order_number, ad_no, buyer_id, buyer_nickname, fiat_amount, fiat_unit, current_state, order_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       current_state=VALUES(current_state),
       order_status=VALUES(order_status),
       updated_at=NOW()`,
      [
        ORDER_NO,
        AD_NO,
        BUYER_ID,
        'FailedBuyer',
        1000,
        'INR',
        'unpaid',
        'pending',
        now
      ]
    );

    console.log(`✅ Order created: ${ORDER_NO}\n`);

    // Step 3: Run eligibility check
    console.log('\n' + '='.repeat(80));
    console.log('🔍 RUNNING ELIGIBILITY CHECK');
    console.log('='.repeat(80) + '\n');

    // Get AD details
    const ad = await sellerOrderDbService.getAdByNo(AD_NO);
    console.log('📋 AD Details:');
    console.log(`   Asset: ${ad.asset}/${ad.fiat_unit}`);
    console.log(`   Classify: ${ad.classify}\n`);

    // Get AD rules
    const rules = await sellerOrderDbService.getAdRules(AD_NO);
    console.log('📋 Required Criteria:');
    console.log(`   Min 30-Day Trades: ${rules.min_30day_trades}`);
    console.log(`   Min Completion Rate: ${rules.min_30day_completion_rate}%`);
    console.log(`   Max Avg Release Time: ${rules.max_avg_release_time > 0 ? rules.max_avg_release_time : 'None'} min`);
    console.log(`   Max Avg Pay Time: ${rules.max_avg_pay_time > 0 ? rules.max_avg_pay_time : 'None'} min`);
    console.log(`   Min Registered Days: ${rules.min_registered_days}`);
    console.log(`   Min Trading Counterparties: ${rules.min_trading_counterparty}`);
    console.log(`   Min All Trades Count: ${rules.min_all_trades_count}`);
    console.log(`   Min Buy Orders: ${rules.min_buy_orders_count}`);
    console.log(`   Min Sell Orders: ${rules.min_sell_orders_count}\n`);

    // Display buyer metrics
    console.log('📊 Buyer Metrics (Low Values):');
    console.log(`   30-Day Trades: ${buyerMetrics.trades_30day} ❌`);
    console.log(`   Completion Rate: ${buyerMetrics.completion_rate_30day}% ❌`);
    console.log(`   Registered Days: ${buyerMetrics.registered_days} ❌`);
    console.log(`   Trading Counterparties: ${buyerMetrics.trading_counterparty_count} ❌`);
    console.log(`   All Trades Count: ${buyerMetrics.all_trades_count} ❌`);
    console.log(`   Buy Orders: ${buyerMetrics.buy_orders_count} ❌`);
    console.log(`   Sell Orders: ${buyerMetrics.sell_orders_count} ❌`);
    console.log(`   Avg Release Time: ${buyerMetrics.avg_release_time_minutes} min ❌`);
    console.log(`   Avg Pay Time: ${buyerMetrics.avg_pay_time_minutes} min ❌\n`);

    // Check eligibility
    const eligibility = await sellerEligibilityService.checkBuyerEligibility(BUYER_ID, AD_NO);

    console.log('\n' + '-'.repeat(80));
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
    }
    console.log('-'.repeat(80) + '\n');

    console.log('\n' + '='.repeat(80));
    console.log('✅ TEST COMPLETED!');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

createFailedOrderAndTest();
