const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

/**
 * Test script for Binance Update Ad API
 * Tests the eligibility sync to Binance
 *
 * Run: node scripts/test-binance-update-api.js
 */

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BINANCE_BASE_URL = 'https://api.binance.com';

if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
  console.error('❌ Error: BINANCE_API_KEY or BINANCE_SECRET_KEY not set in .env');
  process.exit(1);
}

// Helper: Generate HMAC SHA256 signature
function buildSignedQuery(params = {}) {
  const timestamp = Date.now();
  const queryString = Object.entries({ ...params, timestamp })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', BINANCE_SECRET_KEY)
    .update(queryString)
    .digest('hex');

  return `${queryString}&signature=${signature}`;
}

// Test Case 1: Update with Min Trades Only
async function testMinTrades() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: Update with Min 30-Day Trades Only');
  console.log('='.repeat(60));

  try {
    const adNo = '13900814235866066944';
    const payload = {
      advNo: adNo,
      userTradeCountMin: 20,
      userTradeCountFilterTime: 30
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      {
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY,
          'Content-Type': 'application/json',
          'clientType': 'PC'
        },
        timeout: 12000
      }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ Test 1 PASSED\n');
    return true;

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ Test 1 FAILED\n');
    return false;
  }
}

// Test Case 2: Update with Multiple Criteria
async function testMultipleCriteria() {
  console.log('='.repeat(60));
  console.log('TEST 2: Update with Multiple Eligibility Criteria');
  console.log('='.repeat(60));

  try {
    const adNo = '13900814235866066944';
    const payload = {
      advNo: adNo,
      userTradeCountMin: 20,
      userTradeCountFilterTime: 30,
      userTradeCompleteRateMin: 98,
      userTradeCompleteRateFilterTime: 30,
      buyerRegDaysLimit: 100,
      userAllTradeCountMin: 100,
      userBuyTradeCountMin: 75,
      userSellTradeCountMin: 25
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      {
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY,
          'Content-Type': 'application/json',
          'clientType': 'PC'
        },
        timeout: 12000
      }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ Test 2 PASSED\n');
    return true;

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ Test 2 FAILED\n');
    return false;
  }
}

// Test Case 3: Update with Min/Max Ranges
async function testMinMaxRanges() {
  console.log('='.repeat(60));
  console.log('TEST 3: Update with Min/Max Trade Count Ranges');
  console.log('='.repeat(60));

  try {
    const adNo = '13900814235866066944';
    const payload = {
      advNo: adNo,
      userBuyTradeCountMin: 50,
      userBuyTradeCountMax: 1000,
      userSellTradeCountMin: 25,
      userSellTradeCountMax: 1000
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      {
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY,
          'Content-Type': 'application/json',
          'clientType': 'PC'
        },
        timeout: 12000
      }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ Test 3 PASSED\n');
    return true;

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ Test 3 FAILED\n');
    return false;
  }
}

// Test Case 4: Test with Invalid Ad Number (should fail)
async function testInvalidAdNumber() {
  console.log('='.repeat(60));
  console.log('TEST 4: Update with Invalid Ad Number (Expected to Fail)');
  console.log('='.repeat(60));

  try {
    const adNo = '999999999999999999'; // Non-existent ad
    const payload = {
      advNo: adNo,
      userTradeCountMin: 20,
      userTradeCountFilterTime: 30
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      {
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY,
          'Content-Type': 'application/json',
          'clientType': 'PC'
        },
        timeout: 12000
      }
    );

    console.log('❌ Unexpected success (should have failed):');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n❌ Test 4 FAILED (should have received error)\n');
    return false;

  } catch (error) {
    console.log('✅ Got expected error:');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
      console.log('\n✅ Test 4 PASSED (correctly rejected invalid ad)\n');
      return true;
    } else {
      console.log(error.message);
      console.log('\n❌ Test 4 FAILED (unexpected error type)\n');
      return false;
    }
  }
}

// Main test runner
async function runTests() {
  console.log('\n🚀 Starting Binance Update Ad API Tests...');
  console.log(`API Key: ${BINANCE_API_KEY.substring(0, 10)}...`);
  console.log(`Base URL: ${BINANCE_BASE_URL}`);

  const results = [];

  // Run tests
  results.push(await testMinTrades());
  results.push(await testMultipleCriteria());
  results.push(await testMinMaxRanges());
  results.push(await testInvalidAdNumber());

  // Summary
  console.log('='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`Passed: ${passed}/${total}`);

  if (passed === total) {
    console.log('✅ ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log(`❌ ${total - passed} TEST(S) FAILED`);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  runTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  testMinTrades,
  testMultipleCriteria,
  testMinMaxRanges,
  testInvalidAdNumber
};
