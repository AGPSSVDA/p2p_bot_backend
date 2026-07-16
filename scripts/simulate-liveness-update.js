/**
 * Test Script: Simulate Liveness Update
 *
 * Purpose: Simulate what happens when Binance updates additionalKycVerify from 1 to 2
 * This script checks if the backend properly detects the status change
 *
 * Usage:
 *   node scripts/simulate-liveness-update.js <orderNumber>
 *
 * Example:
 *   node scripts/simulate-liveness-update.js 22908992060388339712
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');
const sellerOrderDbService = require('../src/seller/services/sellerOrderDbService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`
Usage: node scripts/simulate-liveness-update.js <orderNumber>
Example: node scripts/simulate-liveness-update.js 22908992060388339712
  `);
  process.exit(1);
}

console.log(`
╔════════════════════════════════════════════════════════════════╗
║     SIMULATE: Liveness Status Update Detection                ║
╚════════════════════════════════════════════════════════════════╝

Order Number: ${TEST_ORDER_NUMBER}

This script will:
1. Check initial order status (should be additionalKycVerify = 1)
2. Simulate user completing liveness on Binance
3. Poll to detect the status change to additionalKycVerify = 2
4. Verify backend processes it correctly

Starting simulation...
════════════════════════════════════════════════════════════════\n
`);

(async () => {
  try {
    // Step 1: Check initial status
    console.log('📋 STEP 1: Checking initial order status...\n');

    const initialStatus = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    if (!initialStatus.success) {
      console.log(`❌ Order not found: ${initialStatus.message}`);
      process.exit(1);
    }

    console.log(`✅ Order found!`);
    console.log(`   Order Number: ${initialStatus.orderNumber}`);
    console.log(`   additionalKycVerify: ${initialStatus.additionalKycVerify}`);
    console.log(`   Status: ${initialStatus.orderStatus}\n`);

    if (initialStatus.additionalKycVerify !== 1) {
      console.log(`⚠️  Order is not in pending liveness state (additionalKycVerify = 1)`);
      console.log(`   Current state: ${initialStatus.additionalKycVerify}`);
      console.log(`   0 = not required, 1 = not verified, 2 = verified\n`);
    }

    // Step 2: Instructions
    console.log(`════════════════════════════════════════════════════════════════`);
    console.log(`\n📝 STEP 2: Complete liveness on Binance\n`);
    console.log(`Now you need to manually complete the liveness check on Binance:`);
    console.log(`  1. Go to your Binance P2P order`);
    console.log(`  2. Complete the liveness verification`);
    console.log(`  3. Come back here and press ENTER to continue\n`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    // Wait for user input
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });

    // Step 3: Poll for status update
    console.log(`\n⏳ STEP 3: Polling for status update...\n`);
    console.log(`Checking every 5 seconds (max 120 checks = 10 minutes)\n`);

    let pollCount = 0;
    let updated = false;
    const maxPolls = 120;

    while (pollCount < maxPolls && !updated) {
      pollCount++;
      const timestamp = new Date().toLocaleTimeString();

      try {
        const status = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

        console.log(`[${timestamp}] Poll #${pollCount}:`);
        console.log(`   additionalKycVerify: ${status.additionalKycVerify}`);

        if (status.additionalKycVerify === 2) {
          console.log(`   ✅ STATUS UPDATED TO 2 (VERIFIED)!`);
          updated = true;
          break;
        } else if (status.additionalKycVerify === 1) {
          console.log(`   ⏳ Still pending (1)...`);
        } else {
          console.log(`   ⚠️  Unexpected value: ${status.additionalKycVerify}`);
        }

      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
      }

      // Wait 5 seconds before next poll
      if (!updated && pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.log(`\n════════════════════════════════════════════════════════════════`);

    if (updated) {
      console.log(`\n✅ SUCCESS: Liveness status updated!`);
      console.log(`\nNow checking database record...\n`);

      const dbOrder = await sellerOrderDbService.getOrderByNumber(TEST_ORDER_NUMBER);

      if (dbOrder) {
        console.log(`✅ Database record found:`);
        console.log(`   Current State: ${dbOrder.current_state}`);
        console.log(`   Liveness Completed At: ${dbOrder.liveness_completed_at}`);
        console.log(`   Liveness Passed: ${dbOrder.liveness_passed}\n`);

        if (dbOrder.current_state === 'LIVENESS_COMPLETED' || dbOrder.current_state === 'ORDER_VERIFIED') {
          console.log(`🎉 COMPLETE SUCCESS!`);
          console.log(`   Backend properly detected and processed liveness update!`);
        } else {
          console.log(`⚠️  Status updated in Binance but backend state is: ${dbOrder.current_state}`);
          console.log(`   Expected: LIVENESS_COMPLETED or ORDER_VERIFIED`);
        }
      } else {
        console.log(`⚠️  Order not found in database`);
      }
    } else {
      console.log(`\n❌ TIMEOUT: Status did not update within 10 minutes`);
      console.log(`\nPossible reasons:`);
      console.log(`  1. Liveness not actually completed on Binance`);
      console.log(`  2. Binance API cache not updated yet (wait a bit longer)`);
      console.log(`  3. Network connectivity issue`);
    }

    console.log(`\n════════════════════════════════════════════════════════════════\n`);
    process.exit(updated ? 0 : 1);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
})();

// Allow Ctrl+C to skip input waiting
process.on('SIGINT', () => {
  console.log('\n\nAborted by user');
  process.exit(0);
});
