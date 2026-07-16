/**
 * TEST SCENARIO 2: Polling Detection
 *
 * Simulate polling loop to detect when liveness changes from 1 → 2
 *
 * Steps:
 * 1. Start with order additionalKycVerify = 1
 * 2. Poll every 2 seconds
 * 3. When detected change (1 → 2), call verifyAdditionalKyc()
 * 4. Verify order status is now 2
 *
 * Usage: node scripts/test-polling-detection.js <orderNumber>
 *
 * This simulates what the handler polling loop does
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 2: Polling Detection Flow                             ║
╚═══════════════════════════════════════════════════════════════╝

Usage: node scripts/test-polling-detection.js <orderNumber>

Expected Flow:
  1. Start polling loop (every 2 seconds)
  2. Track previous additionalKycVerify value
  3. When change detected (1 → 2), call verifyAdditionalKyc()
  4. Confirm status is 2
  5. SUCCESS: Polling worked ✅

Test with an order where:
  - Buyer will complete liveness during polling
  - Or manually modify the order to simulate completion
  `);
  process.exit(1);
}

(async () => {
  try {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST 2: Polling Detection Flow                             ║
╚═══════════════════════════════════════════════════════════════╝

Order: ${orderNo}

Starting polling... (max 2 minutes)
Press Ctrl+C to stop

`);

    // Get initial state
    let previousStatus = null;
    let pollCount = 0;
    let changeDetected = false;
    let verifyAttempted = false;

    const startPolling = () => {
      const interval = setInterval(async () => {
        pollCount++;
        const timestamp = new Date().toLocaleTimeString();

        try {
          const status = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

          if (!status.success) {
            console.log(`[${timestamp}] Poll #${pollCount}: ❌ Order not found`);
            return;
          }

          // First poll - record initial
          if (previousStatus === null) {
            previousStatus = status.additionalKycVerify;
            console.log(`[${timestamp}] Poll #${pollCount}: Initial state = ${previousStatus}`);
            return;
          }

          // Check if changed
          if (status.additionalKycVerify !== previousStatus && !changeDetected) {
            console.log(`[${timestamp}] Poll #${pollCount}: ✨ CHANGE DETECTED!`);
            console.log(`   ${previousStatus} → ${status.additionalKycVerify}`);
            changeDetected = true;

            // If changed to 1 (still pending), try to mark as verified
            if (status.additionalKycVerify === 1 && !verifyAttempted) {
              console.log(`   Calling verifyAdditionalKyc()...\n`);
              verifyAttempted = true;

              try {
                const verifyResult = await sellerBinanceService.verifyAdditionalKyc(orderNo);
                console.log(`   verifyAdditionalKyc Response:`);
                console.log(`   - Status: ${verifyResult.success ? '✅ Success' : '❌ Failed'}`);
                if (verifyResult.kycVerified !== undefined) {
                  console.log(`   - kycVerified: ${verifyResult.kycVerified}`);
                }
                console.log();

                // Wait and re-fetch
                await new Promise(resolve => setTimeout(resolve, 2000));
                const recheck = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
                console.log(`   After verify - additionalKycVerify: ${recheck.additionalKycVerify}\n`);

                if (recheck.additionalKycVerify === 2) {
                  console.log(`✅ SUCCESS: Liveness verified (1 → 2)\n`);
                  clearInterval(interval);
                  process.exit(0);
                }
              } catch (err) {
                console.log(`   ⚠️  verifyAdditionalKyc error: ${err.message}\n`);
              }
            }
            // If already 2, success
            else if (status.additionalKycVerify === 2) {
              console.log(`✅ SUCCESS: Liveness verified (already 2)\n`);
              clearInterval(interval);
              process.exit(0);
            }
          } else if (!changeDetected) {
            console.log(`[${timestamp}] Poll #${pollCount}: No change (still ${status.additionalKycVerify})`);
          }

          previousStatus = status.additionalKycVerify;

        } catch (error) {
          console.log(`[${timestamp}] Poll #${pollCount}: ❌ Error: ${error.message}`);
        }
      }, 2000);

      // Stop after 2 minutes
      setTimeout(() => {
        console.log(`\n⏱️  Polling timeout (2 minutes) - no change detected`);
        clearInterval(interval);
        process.exit(0);
      }, 120000);
    };

    startPolling();

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    process.exit(1);
  }
})();
