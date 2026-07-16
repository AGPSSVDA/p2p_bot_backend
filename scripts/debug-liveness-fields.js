/**
 * Debug Script: Find Liveness Completion Indicator
 *
 * Purpose: Monitor ALL order fields to find what changes when liveness completes
 * This helps us understand the actual Binance behavior
 *
 * Usage:
 *   node scripts/debug-liveness-fields.js <orderNumber>
 *
 * Example:
 *   node scripts/debug-liveness-fields.js 22908992060388339712
 */

require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`
Usage: node scripts/debug-liveness-fields.js <orderNumber>
Example: node scripts/debug-liveness-fields.js 22908992060388339712
  `);
  process.exit(1);
}

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  DEBUG: Monitor ALL Order Fields for Liveness Changes         ║
╚════════════════════════════════════════════════════════════════╝

Order Number: ${TEST_ORDER_NUMBER}

This will:
1. Get initial order state (all fields)
2. Wait for you to complete liveness on Binance
3. Poll and show what fields changed
4. Identify the liveness completion indicator

Starting...
════════════════════════════════════════════════════════════════\n
`);

let previousState = null;

(async () => {
  try {
    // Step 1: Get initial state
    console.log('📋 STEP 1: Getting initial order state...\n');

    const initialResponse = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

    if (!initialResponse.success) {
      console.log(`❌ Order not found: ${initialResponse.message}`);
      process.exit(1);
    }

    const initialOrder = initialResponse.raw;
    previousState = JSON.parse(JSON.stringify(initialOrder)); // Deep copy

    console.log('✅ Initial state captured\n');
    console.log('All fields from Binance:\n');
    Object.keys(initialOrder).forEach(key => {
      console.log(`  ${key}: ${JSON.stringify(initialOrder[key])}`);
    });

    // Step 2: Instructions
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`\n📝 STEP 2: Complete liveness on Binance\n`);
    console.log(`Complete the liveness check now, then press ENTER to continue.\n`);
    console.log(`${'═'.repeat(64)}\n`);

    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });

    // Step 3: Poll and compare
    console.log(`\n⏳ STEP 3: Polling for field changes...\n`);
    console.log(`Checking every 2 seconds (max 150 checks = 5 minutes)\n`);

    let pollCount = 0;
    let foundChanges = false;
    const maxPolls = 150;

    while (pollCount < maxPolls) {
      pollCount++;
      const timestamp = new Date().toLocaleTimeString();

      try {
        const statusResponse = await sellerBinanceService.getOrderStatusByOrderNumber(TEST_ORDER_NUMBER);

        if (!statusResponse.success) {
          console.log(`[${timestamp}] Poll #${pollCount}: ❌ Order not found`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        const currentOrder = statusResponse.raw;

        // Compare with previous state
        let hasChanges = false;
        const changedFields = {};

        Object.keys(currentOrder).forEach(key => {
          const prev = previousState[key];
          const curr = currentOrder[key];

          if (JSON.stringify(prev) !== JSON.stringify(curr)) {
            hasChanges = true;
            changedFields[key] = { previous: prev, current: curr };
          }
        });

        // Check for new fields
        Object.keys(currentOrder).forEach(key => {
          if (!(key in previousState)) {
            hasChanges = true;
            changedFields[key] = { previous: 'NOT_PRESENT', current: currentOrder[key] };
          }
        });

        if (hasChanges) {
          console.log(`\n[${timestamp}] Poll #${pollCount}: ✨ CHANGES DETECTED!\n`);
          console.log(`Changed fields:\n`);

          Object.keys(changedFields).forEach(key => {
            const change = changedFields[key];
            console.log(`  🔄 ${key}:`);
            console.log(`     Before: ${JSON.stringify(change.previous)}`);
            console.log(`     After:  ${JSON.stringify(change.current)}\n`);
          });

          previousState = JSON.parse(JSON.stringify(currentOrder));
          foundChanges = true;

          // Check if this looks like liveness completion
          if (currentOrder.additionalKycVerify === 2 ||
              currentOrder.kycVerified === true ||
              currentOrder.verified === true ||
              (changedFields.additionalKycVerify && changedFields.additionalKycVerify.current === 2)) {
            console.log(`✅ LIVENESS COMPLETED DETECTED!\n`);
            console.log(`Key indicator: additionalKycVerify = ${currentOrder.additionalKycVerify}\n`);
            break;
          }
        } else {
          console.log(`[${timestamp}] Poll #${pollCount}: No changes yet...`);
        }

      } catch (error) {
        console.log(`[${timestamp}] Poll #${pollCount}: ❌ Error: ${error.message}`);
      }

      if (pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n${'═'.repeat(64)}`);

    if (foundChanges) {
      console.log(`\n✅ Analysis complete!`);
      console.log(`\nKey findings:`);
      console.log(`  - Monitor these fields for liveness completion changes`);
      console.log(`  - additionalKycVerify is the main indicator`);
      console.log(`  - Values: 0=not required, 1=not verified, 2=verified`);
    } else {
      console.log(`\n⚠️  No field changes detected in 5 minutes`);
      console.log(`\nPossible issues:`);
      console.log(`  1. Liveness not actually completed on Binance`);
      console.log(`  2. Binance API has very long cache (5+ minutes)`);
      console.log(`  3. Different order or account`);
      console.log(`  4. Binance uses different field for liveness status`);
    }

    console.log(`\n${'═'.repeat(64)}\n`);
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
})();

process.on('SIGINT', () => {
  console.log('\n\nAborted by user');
  process.exit(0);
});
