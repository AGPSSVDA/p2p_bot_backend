/**
 * MONITOR additionalKycVerify FIELD (READ-ONLY, NO SIDE EFFECTS)
 *
 * This script ONLY reads. It NEVER calls verifiedAdditionalKyc (the action endpoint).
 * It polls listOrders + getUserOrderDetail every 3s and prints the raw additionalKycVerify
 * value from BOTH sources, so we can see whether the field ever changes 1 -> 2 after the
 * buyer completes the additional-KYC ("liveness") step on Binance.
 *
 * Usage: node scripts/monitor-kyc-field.js <orderNumber>
 * Example: node scripts/monitor-kyc-field.js 22909338455062822912
 *
 * WHILE THIS RUNS: go to Binance (buyer side) and complete the liveness/KYC step.
 * Watch this output. If additionalKycVerify moves from 1 to 2, our poller design works.
 * If it NEVER moves even after you complete it, the read field is not the completion signal.
 */

const axios = require('axios');
const crypto = require('crypto');
const sellerBinanceConfig = require('../src/config/sellerBinanceConfig');

const orderNo = process.argv[2];
const POLL_MS = 3000;

if (!orderNo) {
  console.log('Usage: node scripts/monitor-kyc-field.js <orderNumber>');
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

async function readFromListOrders() {
  const qs = buildSignedQuery({});
  const res = await axios.post(
    `${baseUrl}/sapi/v1/c2c/orderMatch/listOrders?${qs}`,
    { orderStatusList: [1, 2], tradeType: 'SELL', page: 1, rows: 100 },
    { headers: headers(), timeout: 12000 }
  );
  const data = res.data?.data || res.data;
  const list = Array.isArray(data) ? data : (data?.orderList || data?.data || []);
  const order = list.find(o => o.orderNumber === orderNo);
  return order || null;
}

async function readFromOrderDetail(adOrderNo) {
  if (!adOrderNo) return null;
  const qs = buildSignedQuery({ adOrderNo });
  const res = await axios.post(
    `${baseUrl}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${qs}`,
    { adOrderNo },
    { headers: headers(), timeout: 12000 }
  );
  return res.data?.data || res.data || null;
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

let pollCount = 0;
let lastList = 'INIT';
let lastDetail = 'INIT';

console.log(`\n========================================================`);
console.log(`  READ-ONLY MONITOR for order ${orderNo}`);
console.log(`  Polling every ${POLL_MS / 1000}s. NO side-effect calls.`);
console.log(`  >>> Now go complete the liveness/KYC step on Binance <<<`);
console.log(`  Watch the "additionalKycVerify" columns for a 1 -> 2 change.`);
console.log(`  Press Ctrl+C to stop.`);
console.log(`========================================================\n`);

async function tick() {
  pollCount++;
  try {
    const listOrder = await readFromListOrders();

    if (!listOrder) {
      console.log(`[${ts()}] Poll #${pollCount}: order NOT in pending list (cancelled/completed/not found)`);
      return;
    }

    const adOrderNo = listOrder.adOrderNo || listOrder.advOrderNo;
    const listKyc = listOrder.additionalKycVerify;
    const orderStatus = listOrder.orderStatus;

    let detailKyc = 'n/a';
    try {
      const detail = await readFromOrderDetail(adOrderNo);
      detailKyc = detail ? detail.additionalKycVerify : 'null';
    } catch (e) {
      detailKyc = `ERR(${e.response?.data?.code || e.message})`;
    }

    const changed =
      String(listKyc) !== String(lastList) || String(detailKyc) !== String(lastDetail);
    const marker = changed && pollCount > 1 ? '   <<< CHANGED' : '';

    console.log(
      `[${ts()}] Poll #${pollCount}: ` +
        `listOrders.additionalKycVerify=${listKyc}  ` +
        `getUserOrderDetail.additionalKycVerify=${detailKyc}  ` +
        `orderStatus=${orderStatus}${marker}`
    );

    if (String(listKyc) === '2' || String(detailKyc) === '2') {
      console.log(`\n[${ts()}] ✅ DETECTED additionalKycVerify = 2. This is the real completion signal.`);
      console.log(`    The poller design (wait for 1 -> 2) is correct. Stopping.\n`);
      process.exit(0);
    }

    lastList = String(listKyc);
    lastDetail = String(detailKyc);
  } catch (error) {
    console.log(`[${ts()}] Poll #${pollCount}: ERROR ${error.response?.data?.code || ''} ${error.message}`);
  }
}

tick();
setInterval(tick, POLL_MS);
