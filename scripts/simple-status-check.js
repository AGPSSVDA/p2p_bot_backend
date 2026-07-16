/**
 * Simple Status Check: See all order statuses
 *
 * Usage:
 *   node scripts/simple-status-check.js <orderNumber>
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`Usage: node scripts/simple-status-check.js <orderNumber>`);
  process.exit(1);
}

console.log(`\n📋 Checking order: ${TEST_ORDER_NUMBER}\n`);

(async () => {
  try {
    const response = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    if (!response.success) {
      console.log(`❌ Order not found\n`);
      process.exit(1);
    }

    const order = response.raw;

    console.log(`════════════════════════════════════════════════════════════════`);
    console.log(`\n🔍 ALL RELEVANT FIELDS:\n`);

    // Status fields
    console.log(`STATUS INDICATORS:`);
    console.log(`  orderStatus: ${order.orderStatus}`);
    console.log(`    (1=WAIT_PAYMENT, 2=WAIT_RELEASE, 3=APPEALING, 4=COMPLETED, 6=CANCELLED, 7=SYS_CANCELLED)\n`);

    console.log(`KYC FIELDS:`);
    console.log(`  additionalKycVerify: ${order.additionalKycVerify}`);
    console.log(`    (0=not required, 1=not verified, 2=verified)\n`);

    console.log(`TIMESTAMP FIELDS:`);
    console.log(`  createTime: ${order.createTime}\n`);

    // Other potentially relevant fields
    console.log(`OTHER FIELDS THAT MIGHT INDICATE COMPLETION:`);
    Object.keys(order).forEach(key => {
      if (key.toLowerCase().includes('time') ||
          key.toLowerCase().includes('status') ||
          key.toLowerCase().includes('verified') ||
          key.toLowerCase().includes('kyc') ||
          key.toLowerCase().includes('release') ||
          key.toLowerCase().includes('pay')) {
        console.log(`  ${key}: ${JSON.stringify(order[key])}`);
      }
    });

    console.log(`\n════════════════════════════════════════════════════════════════\n`);

    // Key insight
    if (order.orderStatus === 1) {
      console.log(`⚠️  Order is still in WAIT_PAYMENT state`);
      console.log(`   This suggests liveness may not have actually completed\n`);
    } else if (order.orderStatus === 2) {
      console.log(`✅ Order moved to WAIT_RELEASE state!`);
      console.log(`   This suggests liveness WAS completed\n`);
    }

    console.log(`📌 KEY INSIGHT:`);
    console.log(`   Perhaps we should monitor 'orderStatus' instead of 'additionalKycVerify'`);
    console.log(`   When liveness completes, orderStatus might change\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
