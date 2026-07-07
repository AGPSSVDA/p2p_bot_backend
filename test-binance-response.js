#!/usr/bin/env node

/**
 * Binance Seller Ads - Complete Response Debugger
 * Prints FULL response from Binance API to see all available fields
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const API_KEY = process.env.BINANCE_SELLER_API_KEY;
const API_SECRET = process.env.BINANCE_SELLER_SECRET_KEY;

if (!API_KEY || !API_SECRET) {
  console.error('❌ BINANCE_SELLER_API_KEY or BINANCE_SELLER_SECRET_KEY not in .env');
  process.exit(1);
}

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   Binance Seller Ads - Complete Response Analyzer         ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Function to generate signature (same as production)
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

async function testBinanceResponse() {
  try {
    const queryString = buildSignedQuery();
    const endpoint = '/sapi/v1/c2c/ads/listWithPagination';
    const url = `https://api.binance.com${endpoint}?${queryString}`;

    console.log('📡 Fetching from Binance...\n');
    console.log(`🔗 Endpoint: ${endpoint}`);
    console.log(`🔑 API Key: ${API_KEY.substring(0, 15)}...`);
    console.log(`⏰ Timestamp: ${Date.now()}\n`);

    const res = await axios.post(
      url,
      {
        page: 1,
        rows: 1,  // Get only 1 ad to keep output small
        tradeType: 'SELL'
      },
      {
        headers: {
          'X-MBX-APIKEY': API_KEY,
          'Content-Type': 'application/json',
          'clientType': 'PC'
        },
        timeout: 8000
      }
    );

    console.log('✅ Response received! Status:', res.status);
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    FULL API RESPONSE                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // Pretty print entire response
    console.log(JSON.stringify(res.data, null, 2));

    // Also save to file for reference
    const outputFile = 'binance-response-full.json';
    fs.writeFileSync(outputFile, JSON.stringify(res.data, null, 2));
    console.log(`\n💾 Full response saved to: ${outputFile}`);

    // Extract and analyze first ad
    if (res.data?.data?.data && res.data.data.data.length > 0) {
      const firstAd = res.data.data.data[0];

      console.log('\n╔════════════════════════════════════════════════════════════╗');
      console.log('║                   FIRST AD DETAILS                         ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');

      console.log('📋 Available Fields in Each Ad:\n');

      // Get all keys recursively
      function getAllKeys(obj, prefix = '') {
        let keys = [];
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;

          if (value === null || value === undefined) {
            keys.push(`${fullKey}: null`);
          } else if (typeof value === 'object' && !Array.isArray(value)) {
            keys.push(`${fullKey}: {`);
            keys.push(...getAllKeys(value, fullKey).map(k => '  ' + k));
            keys.push('}');
          } else if (Array.isArray(value)) {
            keys.push(`${fullKey}: [${value.length} items]`);
            if (value.length > 0 && typeof value[0] === 'object') {
              keys.push(`  First item keys:`);
              keys.push(...getAllKeys(value[0], `${fullKey}[0]`).map(k => '    ' + k));
            }
          } else {
            const displayValue = typeof value === 'string' && value.length > 50
              ? value.substring(0, 50) + '...'
              : value;
            keys.push(`${fullKey}: ${displayValue}`);
          }
        }
        return keys;
      }

      const allKeys = getAllKeys(firstAd);
      allKeys.forEach(key => console.log('  ' + key));

      // Save ad details to separate file
      const adFile = 'binance-ad-structure.json';
      fs.writeFileSync(adFile, JSON.stringify(firstAd, null, 2));
      console.log(`\n💾 Ad structure saved to: ${adFile}`);
    }

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                   RESPONSE STRUCTURE                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Top-level keys:');
    Object.keys(res.data).forEach(key => {
      const value = res.data[key];
      console.log(`  ✓ ${key}: ${typeof value} ${Array.isArray(value) ? `[${value.length}]` : ''}`);
    });

    if (res.data?.data) {
      console.log('\nres.data keys:');
      Object.keys(res.data.data).forEach(key => {
        const value = res.data.data[key];
        console.log(`  ✓ ${key}: ${typeof value} ${Array.isArray(value) ? `[${value.length}]` : ''}`);
      });
    }

    console.log('\n✅ Analysis complete!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

testBinanceResponse();
