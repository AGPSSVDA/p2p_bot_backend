/**
 * DUMP RAW ORDER DATA (READ-ONLY, NO SIDE EFFECTS)
 *
 * Prints the COMPLETE raw JSON from listOrders and getUserOrderDetail for one order,
 * so we can see EXACTLY which fields exist and which one reflects liveness/KYC completion.
 * Does NOT call verifiedAdditionalKyc (the side-effect endpoint).
 *
 * Usage: node scripts/dump-order-raw.js <orderNumber>
 *
 * Run this TWICE: once BEFORE completing liveness on Binance, once AFTER.
 * Then diff the two outputs to find which field(s) changed. THAT is the real signal.
 */

const axios = require('axios');
const crypto = require('crypto');
const sellerBinanceConfig = require('../src/config/sellerBinanceConfig');

const orderNo = process.argv[2];
if (!orderNo) {
  console.log('Usage: node scripts/dump-order-raw.js <orderNumber>');
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

function headers() {
  return {
    'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
    'Content-Type': 'application/json',
    'clientType': 'PC',
  };
}

// Print only the keys that could relate to KYC / verification / status, plus a full dump.
function highlightKyc(obj, label) {
  if (!obj || typeof obj !== 'object') {
    console.log(`   (${label}: not an object)`);
    return;
  }
  const interesting = Object.keys(obj).filter(k =>
    /kyc|verif|liveness|status|face|auth/i.test(k)
  );
  console.log(`   >>> KYC/status-related keys in ${label}:`);
  if (interesting.length === 0) {
    console.log(`       (none matched kyc/verif/status/face/auth)`);
  } else {
    interesting.forEach(k => console.log(`       ${k} = ${JSON.stringify(obj[k])}`));
  }
}

async function main() {
  console.log(`\n============ RAW DUMP for order ${orderNo} @ ${new Date().toISOString()} ============\n`);

  // ---- listOrders ----
  console.log('--- 1) listOrders ---');
  let adOrderNo = null;
  try {
    const qs = buildSignedQuery({});
    const res = await axios.post(
      `${baseUrl}/sapi/v1/c2c/orderMatch/listOrders?${qs}`,
      { orderStatusList: [1, 2], tradeType: 'SELL', page: 1, rows: 100 },
      { headers: headers(), timeout: 12000 }
    );
    const data = res.data?.data || res.data;
    const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
    const order = list.find(o => o.orderNumber === orderNo);
    if (!order) {
      console.log('   Order NOT found in pending list.');
    } else {
      adOrderNo = order.adOrderNo || order.advOrderNo;
      console.log('   FULL listOrders item:');
      console.log(JSON.stringify(order, null, 2));
      highlightKyc(order, 'listOrders');
      console.log(`   adOrderNo resolved = ${adOrderNo}`);
    }
  } catch (e) {
    console.log(`   ERROR: ${e.response?.status} ${JSON.stringify(e.response?.data || e.message)}`);
  }

  // ---- getUserOrderDetail (try adOrderNo, then orderNumber as fallback) ----
  console.log('\n--- 2) getUserOrderDetail (param: adOrderNo) ---');
  await dumpDetail({ adOrderNo });

  console.log('\n--- 3) getUserOrderDetail (param: orderNumber, in case adOrderNo is wrong) ---');
  await dumpDetail({ adOrderNo: orderNo });

  console.log(`\n============ END DUMP ============\n`);
  console.log('NEXT: run this again AFTER completing liveness on Binance, then compare the two dumps.');
}

async function dumpDetail(bodyParams) {
  try {
    const qs = buildSignedQuery(bodyParams);
    const res = await axios.post(
      `${baseUrl}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${qs}`,
      bodyParams,
      { headers: headers(), timeout: 12000 }
    );
    const data = res.data?.data || res.data;
    console.log('   FULL getUserOrderDetail response.data:');
    console.log(JSON.stringify(data, null, 2));
    highlightKyc(data, 'getUserOrderDetail');
  } catch (e) {
    console.log(`   ERROR: ${e.response?.status} ${JSON.stringify(e.response?.data || e.message)}`);
  }
}

main();
