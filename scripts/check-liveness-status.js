/**
 * CHECK LIVENESS STATUS
 *
 * Debug script to check if liveness is actually verified on Binance
 *
 * Usage: node scripts/check-liveness-status.js <orderNumber>
 *
 * Example: node scripts/check-liveness-status.js 22909331294027100160
 */

const axios = require('axios');
const crypto = require('crypto');
const sellerBinanceConfig = require('../src/config/sellerBinanceConfig');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   CHECK: Liveness Status on Binance                          ║
╚═══════════════════════════════════════════════════════════════╝

This script checks if liveness is actually verified on Binance.

Usage: node scripts/check-liveness-status.js <orderNumber>

Example: node scripts/check-liveness-status.js 22909331294027100160
  `);
  process.exit(1);
}

const baseUrl = 'https://api.binance.com';

function buildSignedQuery(params = {}) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryStr = Object.entries(allParams)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = crypto
    .createHmac('sha256', sellerBinanceConfig.secretKey)
    .update(queryStr)
    .digest('hex');
  return `${queryStr}&signature=${signature}`;
}

function headers(extra = {}) {
  return {
    'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
    'Content-Type': 'application/json',
    'clientType': 'PC',
    ...extra,
  };
}

async function checkLivenessStatus() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   CHECKING LIVENESS STATUS FOR ORDER: ${orderNo}
╚═══════════════════════════════════════════════════════════════╝
  `);

  try {
    // ===== METHOD 1: Check via listOrders (What poller uses) =====
    console.log('\n📋 METHOD 1: Fetch from listOrders (primary source)');
    console.log('   This is what the poller checks\n');

    const qs1 = buildSignedQuery({});
    const res1 = await axios.post(
      `${baseUrl}/sapi/v1/c2c/orderMatch/listOrders?${qs1}`,
      {
        orderStatusList: [1, 2],
        tradeType: 'SELL',
        page: 1,
        rows: 100,
      },
      { headers: headers(), timeout: 12000 }
    );

    const listData = res1.data?.data || res1.data;
    const list = Array.isArray(listData) ? listData : (listData?.orderList || listData?.data || []);

    const order = list.find(o => o.orderNumber === orderNo);

    if (!order) {
      console.log('   ❌ Order NOT FOUND in listOrders');
      console.log('   This means order is no longer pending or was cancelled');
      return;
    }

    console.log('   ✅ Order found in listOrders');
    console.log(`\n   📊 Order Status from listOrders:`);
    console.log(`      orderNumber: ${order.orderNumber}`);
    console.log(`      orderStatus: ${order.orderStatus} (1=WAIT_PAYMENT, 2=WAIT_RELEASE)`);
    console.log(`      additionalKycVerify: ${order.additionalKycVerify}`);
    console.log(`        ↳ 0 = Not required`);
    console.log(`        ↳ 1 = PENDING (buyer hasn't completed)`);
    console.log(`        ↳ 2 = VERIFIED (buyer completed) ✅`);
    console.log(`      kycVerified: ${order.kycVerified}`);
    console.log(`      chatUnreadCount: ${order.chatUnreadCount}`);

    const adOrderNo = order.adOrderNo || order.advOrderNo;
    console.log(`      adOrderNo: ${adOrderNo}`);

    // ===== METHOD 2: Check via getUserOrderDetail (detailed info) =====
    if (adOrderNo) {
      console.log('\n🔍 METHOD 2: Fetch from getUserOrderDetail (detailed)');
      console.log('   This gives more detailed order info\n');

      try {
        const qs2 = buildSignedQuery({ adOrderNo });
        const res2 = await axios.post(
          `${baseUrl}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${qs2}`,
          { adOrderNo },
          { headers: headers(), timeout: 12000 }
        );

        const detail = res2.data?.data || res2.data;

        console.log('   ✅ Got details from getUserOrderDetail');
        console.log(`\n   📊 Detailed Status:`);
        console.log(`      orderNumber: ${detail?.orderNumber}`);
        console.log(`      orderStatus: ${detail?.orderStatus}`);
        console.log(`      additionalKycVerify: ${detail?.additionalKycVerify}`);
        console.log(`      kycVerified: ${detail?.kycVerified}`);
        console.log(`      createTime: ${detail?.createTime}`);
        console.log(`      updateTime: ${detail?.updateTime}`);

      } catch (err) {
        console.log(`   ⚠️  Could not fetch from getUserOrderDetail: ${err.message}`);
      }
    }

    // ===== METHOD 3: Call verifyAdditionalKyc endpoint =====
    console.log('\n🔑 METHOD 3: Call verifyAdditionalKyc endpoint');
    console.log('   This endpoint tells us if liveness is verified\n');

    try {
      const qs3 = buildSignedQuery({ orderNumber: orderNo });
      const res3 = await axios.post(
        `${baseUrl}/sapi/v1/c2c/orderMatch/verifiedAdditionalKyc?${qs3}`,
        { orderNumber: orderNo },
        { headers: headers(), timeout: 12000 }
      );

      const verifyData = res3.data?.data || res3.data;
      console.log('   ✅ Response from verifyAdditionalKyc:');
      console.log(`      code: ${res3.data?.code}`);
      console.log(`      message: ${res3.data?.message}`);
      console.log(`      kycVerified: ${verifyData?.kycVerified}`);
      console.log(`      success: ${res3.data?.success}`);

      if (verifyData?.kycVerified === true) {
        console.log('\n      🎉 LIVENESS IS VERIFIED on this endpoint!');
      } else {
        console.log('\n      ⚠️  Endpoint says kycVerified is NOT true');
      }

    } catch (err) {
      console.log(`   ⚠️  Error calling verifyAdditionalKyc: ${err.message}`);
      if (err.response?.data) {
        console.log(`      Response: ${JSON.stringify(err.response.data)}`);
      }
    }

    // ===== DIAGNOSIS =====
    console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
    console.log(`║   DIAGNOSIS                                                   ║`);
    console.log(`╚═══════════════════════════════════════════════════════════════╝\n`);

    if (!order) {
      console.log(`❌ Order not found - it may have been cancelled or is no longer pending`);
    } else if (order.additionalKycVerify === 2) {
      console.log(`✅ SUCCESS: additionalKycVerify = 2 (VERIFIED)`);
      console.log(`   Liveness IS complete on Binance!`);
      console.log(`   The poller should have detected this.`);
      console.log(`   If poller still shows "pending", restart the server.`);
    } else if (order.additionalKycVerify === 1) {
      console.log(`⚠️  ISSUE: additionalKycVerify = 1 (STILL PENDING)`);
      console.log(`   Liveness is NOT yet verified on Binance.`);
      console.log(`   Possible reasons:`);
      console.log(`   1. You haven't actually completed liveness on Binance UI yet`);
      console.log(`   2. Liveness process was cancelled or failed`);
      console.log(`   3. Different account was used to complete liveness`);
      console.log(`   4. Binance API hasn't updated yet (try again in 30 seconds)`);
    } else if (order.additionalKycVerify === 0) {
      console.log(`ℹ️  INFO: additionalKycVerify = 0 (NOT REQUIRED)`);
      console.log(`   This ad doesn't require liveness verification`);
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (error.response?.data) {
      console.log(`   Binance API response:`, error.response.data);
    }
  }
}

checkLivenessStatus();
