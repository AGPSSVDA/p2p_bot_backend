require('dotenv').config();
const { pool } = require('./src/config/mysql');

async function checkOrdersInDB() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 CHECKING ORDERS IN DATABASE');
    console.log('='.repeat(80) + '\n');

    // Get all orders from database
    const [allOrders] = await pool.query(
      `SELECT
        order_number,
        ad_no,
        buyer_id,
        buyer_nickname,
        fiat_amount,
        fiat_unit,
        current_state,
        eligibility_check_passed,
        eligibility_check_completed_at,
        created_at
       FROM seller_orders
       ORDER BY created_at DESC
       LIMIT 20`
    );

    console.log(`📊 Total Orders in Database: ${allOrders.length}\n`);

    if (allOrders.length === 0) {
      console.log('❌ No orders found in database\n');
      process.exit(0);
    }

    // Group by AD
    const ordersByAd = {};
    allOrders.forEach(order => {
      if (!ordersByAd[order.ad_no]) {
        ordersByAd[order.ad_no] = [];
      }
      ordersByAd[order.ad_no].push(order);
    });

    console.log('📋 ORDERS GROUPED BY AD:');
    console.log('─'.repeat(80));

    for (const [adNo, orders] of Object.entries(ordersByAd)) {
      console.log(`\n🎯 AD: ${adNo} (${orders.length} orders)`);
      console.log('─'.repeat(80));

      orders.forEach((order, idx) => {
        console.log(`\n  ${idx + 1}. Order: ${order.order_number}`);
        console.log(`     Buyer: ${order.buyer_nickname}`);
        console.log(`     Buyer ID: ${order.buyer_id}`);
        console.log(`     Amount: ${order.fiat_amount} ${order.fiat_unit}`);
        console.log(`     State: ${order.current_state}`);
        console.log(`     Eligibility: ${order.eligibility_check_passed === 1 ? '✅ PASSED' : order.eligibility_check_passed === 0 ? '❌ FAILED' : '⏳ PENDING'}`);
        console.log(`     Checked At: ${order.eligibility_check_completed_at || 'Not checked yet'}`);
        console.log(`     Created: ${new Date(order.created_at).toLocaleString()}`);
      });
    }

    // Check test AD specifically
    const AD_NO = '13900814235866066944';
    console.log('\n' + '='.repeat(80));
    console.log(`🔍 CHECKING AD ${AD_NO} SPECIFICALLY:`);
    console.log('─'.repeat(80));

    const [adOrders] = await pool.query(
      `SELECT
        order_number,
        buyer_id,
        buyer_nickname,
        fiat_amount,
        current_state,
        eligibility_check_passed
       FROM seller_orders
       WHERE ad_no = ?
       ORDER BY created_at DESC`,
      [AD_NO]
    );

    if (adOrders.length === 0) {
      console.log(`\n❌ No orders found for AD ${AD_NO}\n`);
    } else {
      console.log(`\n✅ Found ${adOrders.length} order(s) for AD ${AD_NO}\n`);
      adOrders.forEach((order, idx) => {
        console.log(`${idx + 1}. ${order.order_number}`);
        console.log(`   Buyer: ${order.buyer_nickname} (${order.buyer_id})`);
        console.log(`   Amount: ${order.fiat_amount}`);
        console.log(`   Eligibility: ${order.eligibility_check_passed === 1 ? '✅ PASSED' : '❌ FAILED'}`);
      });
    }

    // Check buyer metrics for these orders
    if (adOrders.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log('📊 BUYER METRICS FOR THESE ORDERS:');
      console.log('─'.repeat(80));

      for (const order of adOrders) {
        const [metrics] = await pool.query(
          `SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?`,
          [order.buyer_id]
        );

        console.log(`\n👤 ${order.buyer_nickname} (${order.buyer_id}):`);
        if (metrics.length === 0) {
          console.log('   ⚠️  No metrics found in database');
        } else {
          const m = metrics[0];
          console.log(`   30-Day Trades: ${m.trades_30day}`);
          console.log(`   Completion Rate: ${m.completion_rate_30day}%`);
          console.log(`   Registered Days: ${m.registered_days}`);
          console.log(`   Trading Counterparties: ${m.trading_counterparty_count}`);
          console.log(`   All Trades: ${m.all_trades_count}`);
          console.log(`   Buy Orders: ${m.buy_orders_count}`);
          console.log(`   Sell Orders: ${m.sell_orders_count}`);
          console.log(`   Avg Release Time: ${m.avg_release_time_minutes} min`);
          console.log(`   Avg Pay Time: ${m.avg_pay_time_minutes} min`);
        }
      }
    }

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

checkOrdersInDB();
