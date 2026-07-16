/**
 * Test Script: Liveness Polling
 *
 * Purpose: Simulate and test the liveness polling mechanism
 *
 * Usage:
 *   node scripts/test-liveness-polling.js <orderNumber>
 *
 * Example:
 *   node scripts/test-liveness-polling.js 22908976868797550592
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');
const sellerOrderDbService = require('../src/seller/services/sellerOrderDbService');

// Test data
const TEST_ORDER_NUMBER = process.argv[2] || '22908976868797550592';
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLLS = 120; // 10 minutes (120 * 5 seconds)

console.log(`
╔════════════════════════════════════════════════════════════════╗
║          LIVENESS POLLING TEST SCRIPT                         ║
╚════════════════════════════════════════════════════════════════╝

Testing liveness polling for order: ${TEST_ORDER_NUMBER}
Poll interval: ${POLL_INTERVAL}ms
Max polls: ${MAX_POLLS} (${(MAX_POLLS * POLL_INTERVAL) / 60000} minutes)

This script will:
1. Fetch order from Binance every ${POLL_INTERVAL}ms
2. Check additionalKycVerify and additionalKycVerified fields
3. Report when liveness is completed
4. Fetch database record to verify sync

Starting polling...
════════════════════════════════════════════════════════════════\n
`);

let pollCount = 0;
let found = false;

const pollLiveness = async () => {
  pollCount++;
  const timestamp = new Date().toLocaleTimeString();

  try {
    console.log(`\n[${timestamp}] Poll #${pollCount}:`);

    // Step 1: Fetch order status from Binance
    console.log(`  📡 Fetching order ${TEST_ORDER_NUMBER} from Binance...`);
    const orderStatus = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    if (!orderStatus.success) {
      console.log(`  ❌ Order not found in Binance pending orders`);
      console.log(`     Message: ${orderStatus.message}`);
      return;
    }

    // Step 2: Display order details
    console.log(`  ✅ Order found!`);
    console.log(`     Order Number: ${orderStatus.orderNumber}`);
    console.log(`     Order Status: ${orderStatus.orderStatus}`);
    console.log(`     additionalKycVerify: ${orderStatus.additionalKycVerify} (0=not required, 1=not verified, 2=verified)`);
    console.log(`     kycVerified: ${orderStatus.kycVerified}`);

    // Step 3: Check liveness completion
    // additionalKycVerify values: 0=not required, 1=pending, 2=completed ✅
    if (orderStatus.additionalKycVerify === 1 || orderStatus.additionalKycVerify === 2) {
      console.log(`  📋 Liveness Required: YES`);

      if (orderStatus.additionalKycVerify === 2) {
        console.log(`  ✅ LIVENESS COMPLETED!`);
        console.log(`\n${'═'.repeat(64)}`);
        console.log(`🎉 SUCCESS: Liveness check completed at ${timestamp}`);
        console.log(`${'═'.repeat(64)}\n`);

        // Step 4: Fetch database record
        console.log(`  🔍 Fetching database record...`);
        const dbOrder = await sellerOrderDbService.getOrderByNumber(TEST_ORDER_NUMBER);

        if (dbOrder) {
          console.log(`  ✅ Database record found:`);
          console.log(`     Current State: ${dbOrder.current_state}`);
          console.log(`     Liveness Completed At: ${dbOrder.liveness_completed_at}`);
          console.log(`     Liveness Passed: ${dbOrder.liveness_passed}`);
        } else {
          console.log(`  ⚠️  Database record not found`);
        }

        found = true;
        process.exit(0);
      } else {
        console.log(`  ⏳ Liveness Pending: WAITING FOR BUYER`);
        console.log(`     Please complete liveness check on Binance...`);
      }
    } else {
      console.log(`  📋 Liveness Required: NO (additionalKycVerify = ${orderStatus.additionalKycVerify})`);
    }

    // Step 5: Show raw data for debugging
    if (process.env.DEBUG_LIVENESS) {
      console.log(`  🔬 Raw Binance Response:`);
      console.log(JSON.stringify(orderStatus.raw, null, 4));
    }

  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    if (process.env.DEBUG_LIVENESS) {
      console.log(`     Stack: ${error.stack}`);
    }
  }

  // Continue polling or stop
  if (pollCount >= MAX_POLLS) {
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`❌ TIMEOUT: Max polls reached (${MAX_POLLS} polls, ${(MAX_POLLS * POLL_INTERVAL) / 60000} minutes)`);
    console.log(`${'═'.repeat(64)}\n`);
    process.exit(1);
  }

  // Schedule next poll
  setTimeout(pollLiveness, POLL_INTERVAL);
};

// Start polling
pollLiveness();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\n${'═'.repeat(64)}`);
  console.log(`⏸️  Polling stopped by user after ${pollCount} polls`);
  console.log(`${'═'.repeat(64)}\n`);
  process.exit(0);
});
