/**
 * Direct Binance P2P Update Ad API Test
 * Tests different payload combinations to isolate -9000/187030 error
 *
 * Run: node scripts/test-update-ad-direct.js
 */

const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const BINANCE_SELLER_API_KEY = process.env.BINANCE_SELLER_API_KEY;
const BINANCE_SELLER_SECRET_KEY = process.env.BINANCE_SELLER_SECRET_KEY;
const BINANCE_BASE_URL = 'https://api.binance.com';
const AD_NO = '13900814235866066944';

if (!BINANCE_SELLER_API_KEY || !BINANCE_SELLER_SECRET_KEY) {
  console.error('❌ Error: BINANCE_SELLER_API_KEY or BINANCE_SELLER_SECRET_KEY not set in .env');
  process.exit(1);
}

// Helper: Generate HMAC SHA256 signature
function buildSignedQuery(params = {}) {
  const timestamp = Date.now();
  const queryString = Object.entries({ ...params, timestamp })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', BINANCE_SELLER_SECRET_KEY)
    .update(queryString)
    .digest('hex');

  return `${queryString}&signature=${signature}`;
}

function headers(extra = {}) {
  return {
    'X-MBX-APIKEY': BINANCE_SELLER_API_KEY,
    'Content-Type': 'application/json',
    'clientType': 'PC',
    ...extra,
  };
}

// TEST 1: Minimal payload - just advNo
async function test1MinimalPayload() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: Minimal Payload (advNo only)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 1 PASSED\n');
    return { status: 'PASSED', test: 'Minimal', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 1 FAILED\n');
    return { status: 'FAILED', test: 'Minimal', error: error.response?.data || error.message };
  }
}

// TEST 2: Only userTradeCountMin with FilterTime=1
async function test2TradeCountOnly() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: Trade Count Only (FilterTime=1)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO,
      userTradeCountMin: 30,
      userTradeCountFilterTime: 1  // 1 = Last 30D
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 2 PASSED\n');
    return { status: 'PASSED', test: 'TradeCountOnly', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 2 FAILED\n');
    return { status: 'FAILED', test: 'TradeCountOnly', error: error.response?.data || error.message };
  }
}

// TEST 3: Completion rate as DECIMAL (0.98)
async function test3CompletionRateDecimal() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: Completion Rate as DECIMAL (0.98)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO,
      userTradeCompleteRateMin: 0.98,  // DECIMAL format
      userTradeCompleteRateFilterTime: 1  // 1 = Last 30D
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 3 PASSED\n');
    return { status: 'PASSED', test: 'CompletionRateDecimal', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 3 FAILED\n');
    return { status: 'FAILED', test: 'CompletionRateDecimal', error: error.response?.data || error.message };
  }
}

// TEST 4: Completion rate as PERCENTAGE (98)
async function test4CompletionRatePercentage() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: Completion Rate as PERCENTAGE (98)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO,
      userTradeCompleteRateMin: 98,  // PERCENTAGE format
      userTradeCompleteRateFilterTime: 1  // 1 = Last 30D
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 4 PASSED\n');
    return { status: 'PASSED', test: 'CompletionRatePercentage', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 4 FAILED\n');
    return { status: 'FAILED', test: 'CompletionRatePercentage', error: error.response?.data || error.message };
  }
}

// TEST 5: ALL criteria together (like current code)
async function test5AllCriteria() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: ALL Criteria (Full Payload)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO,
      userTradeCountMin: 30,
      userTradeCountFilterTime: 1,
      userTradeCompleteRateMin: 0.98,  // DECIMAL
      userTradeCompleteRateFilterTime: 1,
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
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 5 PASSED\n');
    return { status: 'PASSED', test: 'AllCriteria', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 5 FAILED\n');
    return { status: 'FAILED', test: 'AllCriteria', error: error.response?.data || error.message };
  }
}

// TEST 6: FilterTime = 2 (All-time instead of Last 30D)
async function test6FilterTimeAllTime() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 6: FilterTime = 2 (All-time)');
  console.log('='.repeat(70));

  try {
    const payload = {
      advNo: AD_NO,
      userTradeCountMin: 30,
      userTradeCountFilterTime: 2,  // 2 = All-time
      userTradeCompleteRateMin: 0.98,
      userTradeCompleteRateFilterTime: 2  // 2 = All-time
    };

    console.log('📤 Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✅ TEST 6 PASSED\n');
    return { status: 'PASSED', test: 'FilterTimeAllTime', response: response.data };

  } catch (error) {
    console.log('❌ Error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(error.message);
    }
    console.log('\n❌ TEST 6 FAILED\n');
    return { status: 'FAILED', test: 'FilterTimeAllTime', error: error.response?.data || error.message };
  }
}

// Run all tests
async function runAllTests() {
  console.log('\n\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(15) + '🧪 Binance P2P Update Ad API Tests' + ' '.repeat(19) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');
  console.log(`\nSeller API Key: ${BINANCE_SELLER_API_KEY.substring(0, 15)}...`);
  console.log(`Ad No: ${AD_NO}`);
  console.log(`Base URL: ${BINANCE_BASE_URL}`);

  const results = [];

  // Run tests sequentially with delays
  results.push(await test1MinimalPayload());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await test2TradeCountOnly());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await test3CompletionRateDecimal());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await test4CompletionRatePercentage());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await test5AllCriteria());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await test6FilterTimeAllTime());

  // Summary
  console.log('\n\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(25) + '📊 TEST SUMMARY' + ' '.repeat(29) + '║');
  console.log('╚' + '═'.repeat(68) + '╝\n');

  const passed = results.filter(r => r.status === 'PASSED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;

  results.forEach((result, idx) => {
    const symbol = result.status === 'PASSED' ? '✅' : '❌';
    console.log(`${symbol} Test ${idx + 1}: ${result.test.padEnd(25)} - ${result.status}`);
  });

  console.log(`\n📈 Results: ${passed} PASSED, ${failed} FAILED out of ${results.length} tests`);

  if (passed === results.length) {
    console.log('\n🎉 ALL TESTS PASSED!');
    process.exit(0);
  } else {
    console.log(`\n⚠️  ${failed} test(s) failed - analyze results above`);
    process.exit(1);
  }
}

// Run
runAllTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
