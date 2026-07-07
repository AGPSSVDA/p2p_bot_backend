#!/usr/bin/env node

/**
 * Quick Binance Seller API Tester
 * Tests which endpoint works for seller ads
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_SELLER_API_KEY;
const API_SECRET = process.env.BINANCE_SELLER_SECRET_KEY;

if (!API_KEY || !API_SECRET) {
  console.error('❌ BINANCE_SELLER_API_KEY or BINANCE_SELLER_SECRET_KEY not in .env');
  process.exit(1);
}

console.log('🔍 Testing Binance Seller API Keys...\n');
console.log('📝 API Key:', API_KEY.substring(0, 20) + '...');
console.log('📝 API Secret:', API_SECRET.substring(0, 20) + '...\n');

// Function to generate signature
function buildSignedQuery(params = {}) {
  const timestamp = Date.now();
  const queryObject = {
    timestamp,
    ...params,
  };

  const queryString = Object.entries(queryObject)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(queryString)
    .digest('hex');

  return `${queryString}&signature=${signature}`;
}

const ENDPOINTS = [
  {
    name: 'V1 - listWithPagination',
    path: '/sapi/v1/c2c/ads/listWithPagination',
    method: 'POST',
  },
  {
    name: 'V1 - searchAdsByPage',
    path: '/sapi/v1/c2c/ads/searchAdsByPage',
    method: 'POST',
  },
  {
    name: 'V1 - user/ads/list',
    path: '/sapi/v1/c2c/user/ads/list',
    method: 'POST',
  },
  {
    name: 'V2 - c2c/ads/list',
    path: '/sapi/v2/c2c/ads/list',
    method: 'POST',
  },
  {
    name: 'V1 - user/advertisement/list',
    path: '/sapi/v1/c2c/user/advertisement/list',
    method: 'POST',
  },
  {
    name: 'V1 - c2c/ads/list',
    path: '/sapi/v1/c2c/ads/list',
    method: 'POST',
  },
];

async function testEndpoint(endpoint) {
  try {
    const qs = buildSignedQuery({ rows: 10, page: 1 });
    const url = `https://api.binance.com${endpoint.path}?${qs}`;

    console.log(`\n🧪 Testing: ${endpoint.name}`);
    console.log(`   Path: ${endpoint.path}`);

    const response = await axios({
      method: endpoint.method,
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
      data: { page: 1, rows: 10 },
      validateStatus: () => true, // Don't throw on any status
    });

    const status = response.status;

    if (status === 200) {
      const dataCount = Array.isArray(response.data?.data)
        ? response.data.data.length
        : Array.isArray(response.data)
        ? response.data.length
        : 0;

      console.log(`   ✅ SUCCESS (200) - Found ${dataCount} ads`);
      if (dataCount > 0) {
        const firstAd = Array.isArray(response.data?.data)
          ? response.data.data[0]
          : Array.isArray(response.data)
          ? response.data[0]
          : {};
        console.log(`   📋 Sample: ${JSON.stringify(firstAd).substring(0, 100)}...`);
      }
      return { success: true, endpoint, status, data: response.data };
    } else if (status === 401 || status === 403) {
      console.log(`   ⚠️  Permission Error (${status})`);
      console.log(`   Message: ${response.data?.msg || response.statusText}`);
      return { success: false, endpoint, status, reason: 'Permission' };
    } else if (status === 404) {
      console.log(`   ❌ Endpoint Not Found (404)`);
      return { success: false, endpoint, status, reason: '404' };
    } else {
      console.log(`   ❌ Error (${status}): ${response.statusText}`);
      return { success: false, endpoint, status, reason: response.statusText };
    }
  } catch (error) {
    console.log(`   ❌ Network Error: ${error.message}`);
    return { success: false, endpoint, error: error.message };
  }
}

async function main() {
  console.log(`\n🔄 Testing ${ENDPOINTS.length} endpoints...\n`);
  console.log('═'.repeat(60));

  const results = [];
  for (const endpoint of ENDPOINTS) {
    const result = await testEndpoint(endpoint);
    results.push(result);
    await new Promise((r) => setTimeout(r, 500)); // Rate limit
  }

  console.log('\n' + '═'.repeat(60));
  console.log('\n📊 SUMMARY:\n');

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    console.log('✅ WORKING ENDPOINTS:');
    successful.forEach((r) => {
      console.log(`   • ${r.endpoint.name} (${r.endpoint.path})`);
      console.log(`     Update .env: BINANCE_SELLER_ADS_ENDPOINT=${r.endpoint.path}`);
    });
  } else {
    console.log('❌ NO WORKING ENDPOINTS FOUND\n');
    console.log('Possible causes:');
    console.log('  1. Merchant account NOT approved yet');
    console.log('  2. API key does NOT have C2C Trading permission');
    console.log('  3. IP whitelist doesn\'t include your server IP');
    console.log('  4. Wrong API keys (copy-paste error)');
  }

  if (failed.length > 0) {
    console.log(`\n❌ FAILED ENDPOINTS (${failed.length}):`);
    failed.forEach((r) => {
      const reason = r.reason || r.error;
      console.log(`   • ${r.endpoint.name}: ${reason}`);
    });
  }

  console.log('\n' + '═'.repeat(60));
  console.log('\nℹ️  NEXT STEPS:\n');
  if (successful.length > 0) {
    console.log('✅ Update .env with the working endpoint and restart backend!');
  } else {
    console.log('❌ Check Binance API settings:');
    console.log('   1. Go: https://www.binance.com/en/account/api-management');
    console.log('   2. Enable: C2C Trading ✅');
    console.log('   3. Enable: Spot & Margin Trading ✅');
    console.log('   4. Add IP: Your server IP to whitelist');
    console.log('   5. Check: Merchant account status at https://www.binance.com/en/c2c/trade');
  }
  console.log('');
  console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
