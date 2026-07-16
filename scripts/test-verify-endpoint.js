/**
 * TEST SCENARIO 3: verifyAdditionalKyc Endpoint Behavior
 *
 * Test what verifyAdditionalKyc endpoint returns and does
 *
 * Steps:
 * 1. Get order with additionalKycVerify = 1
 * 2. Call verifyAdditionalKyc()
 * 3. Check ALL response fields
 * 4. Check if kycVerified field is reliable indicator
 * 5. Verify order status updated
 *
 * Usage: node scripts/test-verify-endpoint.js <orderNumber>
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 3: verifyAdditionalKyc Endpoint Behavior              ║
╚═══════════════════════════════════════════════════════════════╝

Usage: node scripts/test-verify-endpoint.js <orderNumber>

This test inspects the verifyAdditionalKyc response to understand:
  - What fields it returns
  - Whether kycVerified is a reliable indicator
  - How to interpret the response
  - When to consider liveness "verified"

Test with any order with additionalKycVerify = 1
  `);
  process.exit(1);
}

(async () => {
  try {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 3: verifyAdditionalKyc Endpoint Behavior              ║
╚═══════════════════════════════════════════════════════════════╝

Order: ${orderNo}

`);

    // STEP 1: Get current status
    console.log(`📍 STEP 1: Getting current status...\n`);
    const before = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

    if (!before.success) {
      console.log(`❌ Order not found\n`);
      process.exit(1);
    }

    console.log(`  additionalKycVerify: ${before.additionalKycVerify}`);
    console.log(`  All KYC-related fields:`);
    Object.keys(before).forEach(key => {
      if (key.toLowerCase().includes('kyc') || key.toLowerCase().includes('verify')) {
        console.log(`    - ${key}: ${JSON.stringify(before[key])}`);
      }
    });
    console.log();

    // STEP 2: Call endpoint
    console.log(`📍 STEP 2: Calling verifyAdditionalKyc()...\n`);
    console.log(`  Endpoint: POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc`);
    console.log(`  Payload: { orderNumber: "${orderNo}" }`);
    console.log();

    const response = await sellerBinanceService.verifyAdditionalKyc(orderNo);

    // STEP 3: Inspect response
    console.log(`📍 STEP 3: Response Analysis\n`);
    console.log(`  Full Response:`, JSON.stringify(response, null, 2));
    console.log();

    console.log(`📊 Response Fields:\n`);
    Object.keys(response).forEach(key => {
      console.log(`  ${key}: ${JSON.stringify(response[key])}`);
    });
    console.log();

    // STEP 4: Check success
    console.log(`📍 STEP 4: Success Indicators\n`);
    console.log(`  response.success: ${response.success}`);
    console.log(`  response.kycVerified: ${response.kycVerified}`);
    console.log(`  response.code: ${response.code}`);
    console.log(`  response.message: ${response.message}`);
    console.log();

    if (!response.success) {
      console.log(`⚠️  Endpoint returned success=false`);
      console.log(`   This might mean:`);
      console.log(`   - Liveness was not actually completed by buyer`);
      console.log(`   - Order is in wrong state`);
      console.log(`   - API error\n`);
      process.exit(0);
    }

    if (response.kycVerified !== true) {
      console.log(`⚠️  kycVerified is not true (got ${response.kycVerified})`);
      console.log(`   This might indicate liveness not actually verified\n`);
    }

    // STEP 5: Verify order status changed
    console.log(`📍 STEP 5: Verifying order status changed...\n`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const after = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

    console.log(`  Before: additionalKycVerify = ${before.additionalKycVerify}`);
    console.log(`  After:  additionalKycVerify = ${after.additionalKycVerify}`);
    console.log();

    if (after.additionalKycVerify === 2) {
      console.log(`✅ SUCCESS: Order status updated to 2 (VERIFIED)`);
      console.log(`   Endpoint worked correctly\n`);
    } else if (after.additionalKycVerify === 1) {
      console.log(`⚠️  Order status still 1 (not updated)`);
      console.log(`   Endpoint returned success but status didn't change\n`);
    } else {
      console.log(`❓ Order status is now ${after.additionalKycVerify}\n`);
    }

    // STEP 6: Recommendations
    console.log(`📋 RECOMMENDATIONS:\n`);
    console.log(`  1. Use response.success to detect if verify was attempted`);
    console.log(`  2. Use response.kycVerified to confirm liveness was verified`);
    console.log(`  3. Re-fetch order to confirm additionalKycVerify changed to 2`);
    console.log(`  4. Consider response success + re-fetch confirmation as final check\n`);

    process.exit(0);

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    console.error(error);
    process.exit(1);
  }
})();
