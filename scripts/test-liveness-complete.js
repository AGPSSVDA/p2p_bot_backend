/**
 * TEST SCENARIO 1: Liveness Complete Flow
 *
 * User completes liveness on Binance → We detect and mark verified
 *
 * Steps:
 * 1. Get order with additionalKycVerify = 1
 * 2. Call verifyAdditionalKyc()
 * 3. Response should have kycVerified = true
 * 4. Re-fetch order, additionalKycVerify should be 2
 *
 * Usage: node scripts/test-liveness-complete.js <orderNumber>
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 1: Liveness Complete Flow                             ║
╚═══════════════════════════════════════════════════════════════╝

Usage: node scripts/test-liveness-complete.js <orderNumber>

Expected Flow:
  1. Get order status (additionalKycVerify should be 1)
  2. Call verifyAdditionalKyc()
  3. Check response: kycVerified should be true
  4. Re-fetch order: additionalKycVerify should be 2
  5. SUCCESS: Liveness verified ✅

Test with an order where:
  - Buyer has completed liveness on Binance
  - additionalKycVerify is still 1 (not yet marked verified)
  `);
  process.exit(1);
}

(async () => {
  try {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 1: Liveness Complete Flow                             ║
╚═══════════════════════════════════════════════════════════════╝

Order: ${orderNo}

`);

    // STEP 1: Get initial status
    console.log(`📍 STEP 1: Fetching initial order status...\n`);
    const initial = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

    if (!initial.success) {
      console.log(`❌ Order not found\n`);
      process.exit(1);
    }

    console.log(`  additionalKycVerify: ${initial.additionalKycVerify}`);
    console.log(`  (0=not required, 1=pending, 2=verified)\n`);

    if (initial.additionalKycVerify !== 1) {
      console.log(`⚠️  Expected additionalKycVerify = 1, but got ${initial.additionalKycVerify}`);
      console.log(`   Test only works with pending liveness orders\n`);
      process.exit(0);
    }

    // STEP 2: Call verifyAdditionalKyc
    console.log(`📍 STEP 2: Calling verifyAdditionalKyc()...\n`);
    const verifyResponse = await sellerBinanceService.verifyAdditionalKyc(orderNo);

    console.log(`  Status: ${verifyResponse.success ? '✅ Success' : '❌ Failed'}`);
    console.log(`  Message: ${verifyResponse.message || 'None'}`);
    if (verifyResponse.kycVerified !== undefined) {
      console.log(`  kycVerified: ${verifyResponse.kycVerified}`);
    }
    console.log();

    if (!verifyResponse.success) {
      console.log(`❌ verifyAdditionalKyc failed\n`);
      process.exit(1);
    }

    if (verifyResponse.kycVerified !== true) {
      console.log(`⚠️  Expected kycVerified = true, but got ${verifyResponse.kycVerified}\n`);
    }

    // STEP 3: Wait and re-fetch
    console.log(`📍 STEP 3: Waiting 2 seconds then re-fetching...\n`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const updated = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

    console.log(`  additionalKycVerify: ${updated.additionalKycVerify}\n`);

    // STEP 4: Verify result
    console.log(`📍 STEP 4: Verification\n`);
    if (updated.additionalKycVerify === 2) {
      console.log(`✅ SUCCESS: additionalKycVerify changed 1 → 2`);
      console.log(`   Liveness is now VERIFIED\n`);
    } else {
      console.log(`❌ FAILED: additionalKycVerify is still ${updated.additionalKycVerify}`);
      console.log(`   Expected 2\n`);
    }

    process.exit(0);

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    console.error(error);
    process.exit(1);
  }
})();
