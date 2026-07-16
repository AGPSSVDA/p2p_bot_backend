/**
 * Check ALL KYC-related fields in order response
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`Usage: node scripts/check-all-kyc-fields.js <orderNumber>`);
  process.exit(1);
}

console.log(`\n📋 Checking ALL KYC fields: ${TEST_ORDER_NUMBER}\n`);

(async () => {
  try {
    const response = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    if (!response.success) {
      console.log(`❌ Order not found\n`);
      process.exit(1);
    }

    const order = response.raw;

    console.log(`════════════════════════════════════════════════════════════════`);
    console.log(`\n🔍 ALL KYC-RELATED FIELDS:\n`);

    // List all fields that contain "kyc" or "verified"
    Object.keys(order).forEach(key => {
      if (key.toLowerCase().includes('kyc') ||
          key.toLowerCase().includes('verified') ||
          key.toLowerCase().includes('verification')) {
        const value = order[key];
        console.log(`  ${key}: ${JSON.stringify(value)}`);
      }
    });

    console.log(`\n════════════════════════════════════════════════════════════════\n`);

    // Analysis
    console.log(`📊 ANALYSIS:\n`);

    if ('kycVerified' in order) {
      console.log(`✅ kycVerified field EXISTS: ${order.kycVerified}`);
      console.log(`   This might be the actual liveness completion indicator!\n`);
    } else {
      console.log(`❌ kycVerified field NOT present in response\n`);
    }

    console.log(`additionalKycVerify: ${order.additionalKycVerify}`);
    console.log(`   0 = not required, 1 = not verified, 2 = verified\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
