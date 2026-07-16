/**
 * LONG WATCH (READ-ONLY) — detect a delayed additionalKycVerify update.
 *
 * Polls listOrders every 10s for up to 30 minutes and logs the additionalKycVerify
 * and orderStatus for the target order with wall-clock timestamps. Prints a line only
 * on the first poll and whenever ANY value changes, so a delayed 1->2 flip is captured
 * even if it happens many minutes after you complete KYC.
 *
 * Usage: node scripts/long-watch.js <orderNumber>
 */

const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../src/config/sellerBinanceConfig');

const orderNo = process.argv[2];
if (!orderNo) { console.log('Usage: node scripts/long-watch.js <orderNumber>'); process.exit(1); }

function bsq(p = {}) {
  const t = Date.now();
  const a = { ...p, timestamp: t };
  const q = Object.entries(a).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('&');
  return `${q}&signature=${crypto.createHmac('sha256', cfg.secretKey).update(q).digest('hex')}`;
}
const h = { 'X-MBX-APIKEY': cfg.apiKey, 'Content-Type': 'application/json', clientType: 'PC' };

const POLL_MS = 10000;
const MAX_MS = 30 * 60 * 1000;
const start = Date.now();
let n = 0;
let prevKyc = 'INIT';
let prevStatus = 'INIT';

function ts() { return new Date().toISOString().slice(11, 19); }

async function tick() {
  n++;
  if (Date.now() - start > MAX_MS) {
    console.log(`[${ts()}] Reached 30-minute limit. Final: kyc=${prevKyc} status=${prevStatus}. Stopping.`);
    process.exit(0);
  }
  try {
    const lr = await axios.post(
      'https://api.binance.com/sapi/v1/c2c/orderMatch/listOrders?' + bsq({}),
      { orderStatusList: [1, 2, 3, 4], tradeType: 'SELL', page: 1, rows: 100 },
      { headers: h, timeout: 12000 }
    );
    const data = lr.data?.data || lr.data;
    const list = Array.isArray(data) ? data : (data?.orderList || []);
    const o = list.find(x => x.orderNumber === orderNo);
    if (!o) {
      console.log(`[${ts()}] Poll #${n}: order not in list (may have completed/cancelled)`);
      return;
    }
    const kyc = o.additionalKycVerify;
    const status = o.orderStatus;
    const changed = (String(kyc) !== String(prevKyc)) || (String(status) !== String(prevStatus));
    if (n === 1 || changed) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[${ts()}] Poll #${n} (+${elapsed}s): additionalKycVerify=${kyc} orderStatus=${status}` +
        (changed && n > 1 ? `   <<< CHANGED (was kyc=${prevKyc} status=${prevStatus})` : ''));
    }
    if (kyc === 2 && prevKyc !== 2) {
      console.log(`\n[${ts()}] ✅ additionalKycVerify reached 2 after +${Math.round((Date.now()-start)/1000)}s. THIS is the timing. Stopping.\n`);
      process.exit(0);
    }
    prevKyc = kyc; prevStatus = status;
  } catch (e) {
    console.log(`[${ts()}] Poll #${n}: ERROR ${e.response?.status || ''} ${e.message}`);
  }
}

console.log(`\nLong-watching ${orderNo} every ${POLL_MS/1000}s for up to 30 min.`);
console.log(`Only prints on start + changes. Leave it running after you complete KYC.\n`);
tick();
setInterval(tick, POLL_MS);
