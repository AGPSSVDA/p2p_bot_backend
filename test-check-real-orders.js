require('dotenv').config();
const { pool } = require('./src/config/mysql');
const binanceService = require('./src/services/binanceService');

async function checkRealOrders() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('📦 CHECKING REAL ORDERS FROM BINANCE');
    console.log('='.repeat(80) + '\n');

    // Step 1: Fetch pending orders from Binance
    console.log('Step 1: Fetching pending orders from Binance...\n');
    const orders = await binanceService.getPendingOrders();

    if (!orders || orders.length === 0) {
      console.log('❌ No pending orders found from Binance\n');
      process.exit(0);
    }

    console.log(`✅ Found ${orders.length} pending orders from Binance\n`);

    // Step 2: Display all orders
    console.log('📋 ALL PENDING ORDERS:');
    console.log('─'.repeat(80));
    orders.forEach((order, idx) => {
      console.log(`\n${idx + 1}. Order #${order.orderNumber}`);
      console.log(`   Buyer: ${order.counterPartNickName} (ID: ${order.counterPartUserId})`);
      console.log(`   Ad No: ${order.adOrderNo}`);
      console.log(`   Amount: ${order.totalPrice} ${order.fiat}`);
      console.log(`   Asset: ${order.tradeCoinCode}`);
      console.log(`   Status: ${order.orderStatus}`);
      console.log(`   Created: ${new Date(order.createTime).toLocaleString()}`);
    });

    // Step 3: Check if any are for our test ad
    console.log('\n' + '='.repeat(80));
    console.log('🎯 FILTERING FOR AD 13900814235866066944:');
    console.log('─'.repeat(80));

    const AD_NO = '13900814235866066944';
    const adOrders = orders.filter(o => o.adOrderNo === AD_NO);

    if (adOrders.length === 0) {
      console.log(`\n❌ No orders found for AD ${AD_NO}`);
      console.log('\nOrders found for these ADs:');
      const uniqueAds = [...new Set(orders.map(o => o.adOrderNo))];
      uniqueAds.forEach(ad => console.log(`   - ${ad}`));
    } else {
      console.log(`\n✅ Found ${adOrders.length} order(s) for AD ${AD_NO}\n`);
      adOrders.forEach((order, idx) => {
        console.log(`${idx + 1}. ${order.orderNumber}`);
        console.log(`   Buyer Nickname: ${order.counterPartNickName}`);
        console.log(`   Buyer ID: ${order.counterPartUserId}`);
        console.log(`   Amount: ${order.totalPrice} ${order.fiat}`);
      });
    }

    // Step 4: Check database
    console.log('\n' + '='.repeat(80));
    console.log('💾 CHECKING DATABASE FOR ORDERS:');
    console.log('─'.repeat(80));

    const [dbOrders] = await pool.query(
      'SELECT order_number, buyer_id, buyer_nickname, ad_no, fiat_amount, current_state FROM seller_orders ORDER BY created_at DESC LIMIT 10'
    );

    console.log(`\n✅ Found ${dbOrders.length} orders in database\n`);
    dbOrders.forEach((order, idx) => {
      console.log(`${idx + 1}. ${order.order_number}`);
      console.log(`   Buyer: ${order.buyer_nickname} (${order.buyer_id})`);
      console.log(`   Ad No: ${order.ad_no}`);
      console.log(`   Amount: ${order.fiat_amount}`);
      console.log(`   State: ${order.current_state}`);
    });

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response?.data) {
      console.error('Binance Response:', error.response.data);
    }
  } finally {
    process.exit(0);
  }
}

checkRealOrders();
