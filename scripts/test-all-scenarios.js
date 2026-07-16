/**
 * TEST ALL LIVENESS SCENARIOS
 *
 * Run all test scenarios in sequence
 *
 * Usage: node scripts/test-all-scenarios.js <orderNumber>
 */

const { execSync } = require('child_process');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST: All Liveness Scenarios                               ║
╚═══════════════════════════════════════════════════════════════╝

Usage: node scripts/test-all-scenarios.js <orderNumber>

This will run 3 tests in sequence:

TEST 1: Liveness Complete Flow
  - Get order status
  - Call verifyAdditionalKyc()
  - Verify status changed to 2

TEST 2: Polling Detection Flow (2 minutes max)
  - Start polling loop
  - Detect any status changes
  - Call verify and confirm

TEST 3: Endpoint Behavior
  - Inspect verifyAdditionalKyc response
  - Check all response fields
  - Verify order status updated

Use with an order that has additionalKycVerify = 1
  `);
  process.exit(1);
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST: All Liveness Scenarios                               ║
╚═══════════════════════════════════════════════════════════════╝

Order: ${orderNo}

Running all tests...

`);

const tests = [
  { name: 'TEST 1: Liveness Complete', script: 'scripts/test-liveness-complete.js' },
  { name: 'TEST 2: Polling Detection (2 min max)', script: 'scripts/test-polling-detection.js' },
  { name: 'TEST 3: Endpoint Behavior', script: 'scripts/test-verify-endpoint.js' }
];

let passedCount = 0;
let failedCount = 0;

tests.forEach((test, idx) => {
  console.log(`\n${'═'.repeat(63)}`);
  console.log(`\n${test.name}\n`);
  console.log(`${'═'.repeat(63)}\n`);

  try {
    execSync(`node ${test.script} ${orderNo}`, {
      stdio: 'inherit',
      timeout: 180000  // 3 minutes per test
    });
    passedCount++;
  } catch (error) {
    if (error.killed) {
      console.log(`\n⏱️  Test timeout or interrupted\n`);
    }
    failedCount++;
  }
});

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   TEST SUMMARY                                               ║
╚═══════════════════════════════════════════════════════════════╝

Passed: ${passedCount}
Failed: ${failedCount}

Tests completed. Use these results to understand liveness detection
behavior before implementing in the handler.

Next: Implement proper detection in sellerOrderHandler.js
  `);
