/**
 * Debug Script: Show ALL order fields from Binance
 *
 * Purpose: Inspect what Binance is actually returning for an order
 * to understand how to detect liveness completion
 *
 * Usage:
 *   node scripts/debug-order-fields.js <orderNumber>
 *
 * Example:
 *   node scripts/debug-order-fields.js 22908981457647382528
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`
Usage: node scripts/debug-order-fields.js <orderNumber>
Example: node scripts/debug-order-fields.js 22908981457647382528
  `);
  process.exit(1);
}

console.log(`
╔════════════════════════════════════════════════════════════════╗
║          DEBUG: ORDER FIELDS FROM BINANCE                     ║
╚════════════════════════════════════════════════════════════════╝

Order Number: ${TEST_ORDER_NUMBER}

Fetching order from Binance (using getUserOrderDetail)...
════════════════════════════════════════════════════════════════\n
`);

(async () => {
  try {
    const orderStatus = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    console.log('✅ Order found! Here are ALL the fields:\n');

    if (orderStatus.raw) {
      // Pretty print the entire raw response
      console.log(JSON.stringify(orderStatus.raw, null, 2));
    } else {
      console.log(JSON.stringify(orderStatus, null, 2));
    }

    console.log(`\n${'═'.repeat(64)}\n`);

    // Now extract key fields that might indicate liveness completion
    const raw = orderStatus.raw || orderStatus;

    console.log('🔍 LIVENESS-RELATED FIELDS FOUND:\n');

    const livenessFields = [
      'additionalKycVerify',
      'additionalKycVerified',
      'kycVerified',
      'kycStatus',
      'additionalKyc',
      'additionalKycStatus',
      'kyc_verified',
      'kyc_status',
      'liveness',
      'livenessVerified',
      'verified',
      'verification',
      'verificationStatus'
    ];

    livenessFields.forEach(field => {
      if (field in raw) {
        console.log(`  ✓ ${field}: ${JSON.stringify(raw[field])}`);
      }
    });

    console.log('\n🔍 ORDER STATUS FIELDS:\n');

    const statusFields = [
      'orderStatus',
      'status',
      'orderState',
      'state',
      'tradeStatus',
      'paymentStatus'
    ];

    statusFields.forEach(field => {
      if (field in raw) {
        console.log(`  ✓ ${field}: ${JSON.stringify(raw[field])}`);
      }
    });

    console.log(`\n${'═'.repeat(64)}`);
    console.log(`\n📝 Total fields in response: ${Object.keys(raw).length}\n`);

    // List all field names
    console.log('📋 ALL FIELD NAMES:\n');
    Object.keys(raw).forEach(key => {
      console.log(`  - ${key}`);
    });

    console.log(`\n${'═'.repeat(64)}\n`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
})();
