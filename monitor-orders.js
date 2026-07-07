require('dotenv').config();
const { pool } = require('./src/config/mysql');
const sellerEligibilityService = require('./src/seller/services/sellerEligibilityService');

async function monitorOrders() {
  try {
    console.log('\n' + '█'.repeat(80));
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█' + '  📦 ORDER MONITORING & ELIGIBILITY CHECK'.padEnd(78) + '█');
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█'.repeat(80) + '\n');

    // Get all orders
    const [orders] = await pool.query(
      `SELECT * FROM seller_orders
       ORDER BY created_at DESC
       LIMIT 100`
    );

    if (orders.length === 0) {
      console.log('❌ No orders found in database\n');
      console.log('Waiting for orders to be placed on Binance...\n');
      process.exit(0);
    }

    console.log(`📊 Found ${orders.length} order(s) in database\n`);

    // Process each order
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      console.log('\n' + '─'.repeat(80));
      console.log(`ORDER ${i + 1}/${orders.length}: ${order.order_number}`);
      console.log('─'.repeat(80) + '\n');

      console.log(`📋 Order Details:`);
      console.log(`   Buyer: ${order.buyer_nickname}`);
      console.log(`   Buyer ID: ${order.buyer_id}`);
      console.log(`   KYC Name: ${order.buyer_kyc_name || 'Not provided'}`);
      console.log(`   Amount: ${order.fiat_amount} ${order.fiat_unit}`);
      console.log(`   AD No: ${order.ad_no}`);
      console.log(`   State: ${order.current_state}`);
      console.log(`   Created: ${new Date(order.created_at).toLocaleString()}\n`);

      // Get buyer metrics
      const [metricsRows] = await pool.query(
        'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?',
        [order.buyer_id]
      );

      if (metricsRows.length === 0) {
        console.log('❌ Buyer metrics not found in database');
        console.log('   ⏳ Metrics will be fetched when order is synced from Binance\n');
        continue;
      }

      const metrics = metricsRows[0];

      console.log('📊 Buyer Metrics:');
      console.log(`   30-Day Trades: ${metrics.trades_30day}`);
      console.log(`   Completion Rate: ${metrics.completion_rate_30day}%`);
      console.log(`   Registered Days: ${metrics.registered_days}`);
      console.log(`   Trading Counterparties: ${metrics.trading_counterparty_count}`);
      console.log(`   All Trades: ${metrics.all_trades_count}`);
      console.log(`   Buy Orders: ${metrics.buy_orders_count}`);
      console.log(`   Sell Orders: ${metrics.sell_orders_count}`);
      console.log(`   Avg Release Time: ${metrics.avg_release_time_minutes} min`);
      console.log(`   Avg Pay Time: ${metrics.avg_pay_time_minutes} min\n`);

      // Get AD rules
      const [rulesRows] = await pool.query(
        'SELECT * FROM seller_ad_rules WHERE ad_no = ?',
        [order.ad_no]
      );

      if (rulesRows.length === 0) {
        console.log('⚠️  AD rules not found');
        continue;
      }

      const rules = rulesRows[0];

      console.log('✅ AD Eligibility Requirements:');
      console.log(`   Min 30-Day Trades: ${rules.min_30day_trades}`);
      console.log(`   Min Completion Rate: ${rules.min_30day_completion_rate}%`);
      console.log(`   Max Avg Release Time: ${rules.max_avg_release_time} min`);
      console.log(`   Max Avg Pay Time: ${rules.max_avg_pay_time} min`);
      console.log(`   Min Registered Days: ${rules.min_registered_days}`);
      console.log(`   Min Trading Counterparties: ${rules.min_trading_counterparty}`);
      console.log(`   Min All Trades: ${rules.min_all_trades_count}`);
      console.log(`   Min Buy Orders: ${rules.min_buy_orders_count}`);
      console.log(`   Min Sell Orders: ${rules.min_sell_orders_count}\n`);

      // Run eligibility check
      try {
        const eligibility = await sellerEligibilityService.checkBuyerEligibility(
          order.buyer_id,
          order.ad_no
        );

        console.log('🎯 ELIGIBILITY CHECK RESULT:');
        console.log('─'.repeat(80));
        if (eligibility.eligible) {
          console.log('🟢 ✅ ELIGIBLE - This buyer can proceed!\n');
        } else {
          console.log('🔴 ❌ NOT ELIGIBLE - Failed criteria:\n');
          if (eligibility.failedChecks && eligibility.failedChecks.length > 0) {
            eligibility.failedChecks.forEach((check, idx) => {
              console.log(`   ${idx + 1}. ${check.criterion}`);
              console.log(`      Required: ${check.required}, Actual: ${check.actual}`);
            });
          }
          console.log();
        }
      } catch (err) {
        console.log('⚠️  Could not run eligibility check:', err.message, '\n');
      }
    }

    console.log('\n' + '█'.repeat(80));
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█' + '  ✅ MONITORING COMPLETE'.padEnd(78) + '█');
    console.log('█' + ' '.repeat(78) + '█');
    console.log('█'.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

monitorOrders();
