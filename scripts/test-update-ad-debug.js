/**
 * Debug Binance P2P Update Ad API - Find which field combination breaks
 *
 * Run: node scripts/test-update-ad-debug.js
 */

const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const BINANCE_SELLER_API_KEY = process.env.BINANCE_SELLER_API_KEY;
const BINANCE_SELLER_SECRET_KEY = process.env.BINANCE_SELLER_SECRET_KEY;
const BINANCE_BASE_URL = 'https://api.binance.com';
const AD_NO = '13900814235866066944';

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

async function test(name, payload) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TEST: ${name}`);
  console.log('='.repeat(70));
  console.log('📤 Payload:', JSON.stringify(payload, null, 2));

  try {
    const qs = buildSignedQuery({});
    const response = await axios.post(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/update?${qs}`,
      payload,
      { headers: headers(), timeout: 12000 }
    );

    console.log('✅ PASSED');
    return { name, status: 'PASSED' };
  } catch (error) {
    console.log('❌ FAILED');
    if (error.response) {
      console.log(`Error: ${JSON.stringify(error.response.data)}`);
    } else {
      console.log(`Error: ${error.message}`);
    }
    return { name, status: 'FAILED', error: error.response?.data };
  }
}

async function runDebugTests() {
  console.log('\n🔍 Binance P2P Update Ad API - Debug Tests\n');

  const results = [];

  // Base payload that works
  const base = { advNo: AD_NO };

  // Add fields one by one to find which breaks
  results.push(await test('Base (advNo only)', base));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ userTradeCountMin', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ userTradeCompleteRateMin', {
    ...base,
    userTradeCompleteRateMin: 0.98,
    userTradeCompleteRateFilterTime: 1
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ buyerRegisterLimit', {
    ...base,
    buyerRegisterLimit: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ userAllTradeCountMin', {
    ...base,
    userAllTradeCountMin: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ userBuyTradeCountMin', {
    ...base,
    userBuyTradeCountMin: 75
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('+ userSellTradeCountMin', {
    ...base,
    userSellTradeCountMin: 25
  }));
  await new Promise(r => setTimeout(r, 1000));

  // Now combine successful ones
  console.log('\n\n🔗 COMBINING FIELDS:\n');

  results.push(await test('Trade Count + Registration Days', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    buyerRegisterLimit: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Trade Count + All Trades', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userAllTradeCountMin: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Trade Count + Buy Trades', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userBuyTradeCountMin: 75
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Trade Count + Sell Trades', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userSellTradeCountMin: 25
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Completion Rate + Registration Days', {
    ...base,
    userTradeCompleteRateMin: 0.98,
    userTradeCompleteRateFilterTime: 1,
    buyerRegisterLimit: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('All Trade Counts Together', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userAllTradeCountMin: 100,
    userBuyTradeCountMin: 75,
    userSellTradeCountMin: 25
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Trade Count + Completion Rate', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userTradeCompleteRateMin: 0.98,
    userTradeCompleteRateFilterTime: 1
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('Trade Count + Completion Rate + Registration Days', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userTradeCompleteRateMin: 0.98,
    userTradeCompleteRateFilterTime: 1,
    buyerRegisterLimit: 100
  }));
  await new Promise(r => setTimeout(r, 1000));

  results.push(await test('FULL PAYLOAD (all fields)', {
    ...base,
    userTradeCountMin: 30,
    userTradeCountFilterTime: 1,
    userTradeCompleteRateMin: 0.98,
    userTradeCompleteRateFilterTime: 1,
    buyerRegisterLimit: 100,
    userAllTradeCountMin: 100,
    userBuyTradeCountMin: 75,
    userSellTradeCountMin: 25
  }));

  // Summary
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 SUMMARY');
  console.log('='.repeat(70));

  results.forEach(r => {
    const symbol = r.status === 'PASSED' ? '✅' : '❌';
    console.log(`${symbol} ${r.name}`);
  });

  const passed = results.filter(r => r.status === 'PASSED').length;
  console.log(`\n${passed}/${results.length} tests passed`);
}

runDebugTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
