#!/usr/bin/env node

/**
 * ORDER ELIGIBILITY CHECKER
 *
 * यह script database में से आपके सभी orders को check करता है
 * और हर order के लिए eligibility status show करता है।
 *
 * Usage: node CHECK_MY_ORDERS.js
 */

require('dotenv').config();
const { pool } = require('./src/config/mysql');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');

async function checkMyOrders() {
  try {
    console.log('\n' + '╔' + '═'.repeat(78) + '╗');
    console.log('║' + '  🔍 YOUR ORDERS - ELIGIBILITY CHECK'.padEnd(79) + '║');
    console.log('╚' + '═'.repeat(78) + '╝' + '\n');

    // Get all orders from newest to oldest
    const [orders] = await pool.query(
      `SELECT
        order_number,
        buyer_id,
        buyer_nickname,
        buyer_kyc_name,
        ad_no,
        fiat_amount,
        fiat_unit,
        current_state,
        eligibility_check_passed,
        eligibility_check_completed_at,
        created_at
       FROM seller_orders
       ORDER BY created_at DESC`
    );

    if (orders.length === 0) {
      console.log('❌ कोई भी orders database में नहीं मिले।\n');
      console.log('जब आप Binance पर order place करेंगे, वह यहाँ दिखेंगे।\n');
      process.exit(0);
    }

    console.log(`📊 कुल Orders: ${orders.length}\n`);

    // Process each order
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      // Order header
      console.log('┌' + '─'.repeat(78) + '┐');
      console.log(`│ ORDER ${i + 1}: ${order.order_number}`.padEnd(79) + '│');
      console.log('└' + '─'.repeat(78) + '┘');

      // Order info
      console.log(`\n  👤 Buyer: ${order.buyer_nickname}`);
      console.log(`  🆔 Buyer ID: ${order.buyer_id}`);
      console.log(`  📋 AD: ${order.ad_no}`);
      console.log(`  💰 Amount: ${order.fiat_amount} ${order.fiat_unit}`);
      console.log(`  🔄 Status: ${order.current_state}`);
      console.log(`  📅 Created: ${new Date(order.created_at).toLocaleString()}`);

      // Eligibility status
      if (order.eligibility_check_passed === null) {
        console.log(`  ⏳ Eligibility: PENDING (अभी check नहीं हुआ)`);
      } else if (order.eligibility_check_passed === 1) {
        console.log(`  ✅ Eligibility: PASSED`);
      } else {
        console.log(`  ❌ Eligibility: FAILED`);
      }

      // Get buyer metrics
      const [metricsRows] = await pool.query(
        'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?',
        [order.buyer_id]
      );

      if (metricsRows.length === 0) {
        console.log(`\n  ⚠️  Buyer metrics database में नहीं मिले`);
        console.log(`     Metrics को fetch करने के लिए order को sync होना चाहिए।\n`);
        continue;
      }

      const metrics = metricsRows[0];

      // Show metrics
      console.log(`\n  📊 Buyer की Metrics:`);
      console.log(`     • 30-Day Trades: ${metrics.trades_30day}`);
      console.log(`     • Completion Rate: ${metrics.completion_rate_30day}%`);
      console.log(`     • Registered Days: ${metrics.registered_days}`);
      console.log(`     • Trading Counterparties: ${metrics.trading_counterparty_count}`);
      console.log(`     • All Trades Count: ${metrics.all_trades_count}`);
      console.log(`     • Buy Orders: ${metrics.buy_orders_count}`);
      console.log(`     • Sell Orders: ${metrics.sell_orders_count}`);
      console.log(`     • Avg Release Time: ${metrics.avg_release_time_minutes} min`);
      console.log(`     • Avg Pay Time: ${metrics.avg_pay_time_minutes} min`);

      // Get AD rules
      const [rulesRows] = await pool.query(
        'SELECT * FROM seller_ad_rules WHERE ad_no = ?',
        [order.ad_no]
      );

      if (rulesRows.length === 0) {
        console.log(`\n  ⚠️  AD rules नहीं मिले\n`);
        continue;
      }

      const rules = rulesRows[0];

      // Show requirements
      console.log(`\n  📋 AD की Requirements:`);
      console.log(`     • Min 30-Day Trades: ${rules.min_30day_trades}`);
      console.log(`     • Min Completion Rate: ${rules.min_30day_completion_rate}%`);
      console.log(`     • Max Release Time: ${rules.max_avg_release_time} min`);
      console.log(`     • Max Pay Time: ${rules.max_avg_pay_time} min`);
      console.log(`     • Min Registered Days: ${rules.min_registered_days}`);
      console.log(`     • Min Trading Counterparties: ${rules.min_trading_counterparty}`);
      console.log(`     • Min All Trades: ${rules.min_all_trades_count}`);
      console.log(`     • Min Buy Orders: ${rules.min_buy_orders_count}`);
      console.log(`     • Min Sell Orders: ${rules.min_sell_orders_count}`);

      // Run eligibility check
      try {
        const eligibility = await sellerEligibilityService.checkBuyerEligibility(
          order.buyer_id,
          order.ad_no
        );

        console.log(`\n  🎯 ELIGIBILITY CHECK RESULT:`);
        console.log('  ' + '─'.repeat(76));

        if (eligibility.eligible) {
          console.log(`  🟢 ✅ ELIGIBLE - यह buyer इस order को proceed कर सकता है!\n`);
        } else {
          console.log(`  🔴 ❌ NOT ELIGIBLE - Failed criteria:\n`);
          if (eligibility.failedChecks && eligibility.failedChecks.length > 0) {
            eligibility.failedChecks.forEach((check, idx) => {
              console.log(`     ${idx + 1}. ${check.criterion}`);
              console.log(`        Required: ${check.required}, Actual: ${check.actual}`);
            });
          }
          console.log();
        }
      } catch (err) {
        console.log(`\n  ⚠️  Eligibility check में error: ${err.message}\n`);
      }
    }

    console.log('╔' + '═'.repeat(78) + '╗');
    console.log('║' + '  ✅ CHECK COMPLETE'.padEnd(79) + '║');
    console.log('╚' + '═'.repeat(78) + '╝' + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    process.exit(0);
  }
}

// Run
checkMyOrders();
