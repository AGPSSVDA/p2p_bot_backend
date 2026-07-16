/**
 * COMPREHENSIVE ORDER SNAPSHOT (READ-ONLY, NO SIDE EFFECTS)
 *
 * Captures EVERYTHING that could possibly reflect liveness / additional-KYC completion,
 * from every available read endpoint, and saves the full raw result to a timestamped
 * JSON file so a BEFORE and AFTER run can be diffed exactly.
 *
 * It does NOT call verifiedAdditionalKyc (that endpoint has a side effect of marking
 * the order verified).
 *
 * Usage:
 *   node scripts/snapshot-order.js <orderNumber> before
 *   ...complete liveness on Binance...
 *   node scripts/snapshot-order.js <orderNumber> after
 *
 * Files are written to: scripts/snapshots/<orderNumber>-<label>-<counter>.json
 * Share BOTH files (or their printed contents) and we diff to find the real signal.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const sellerBinanceConfig = require('../src/config/sellerBinanceConfig');

const orderNo = process.argv[2];
const label = (process.argv[3] || 'snap').replace(/[^a-z0-9_-]/gi, '');

if (!orderNo) {
  console.log('Usage: node scripts/snapshot-order.js <orderNumber> <before|after>');
  process.exit(1);
}

const baseUrl = sellerBinanceConfig.baseUrl;
const EP = sellerBinanceConfig.endpoints;

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

async function post(endpoint, body = {}, extraQuery = {}) {
  const qs = buildSignedQuery({ ...body, ...extraQuery });
  const res = await axios.post(`${baseUrl}${endpoint}?${qs}`, body, {
    headers: headers(),
    timeout: 15000,
  });
  return res.data;
}

async function get(endpoint, query = {}) {
  const qs = buildSignedQuery(query);
  const res = await axios.get(`${baseUrl}${endpoint}?${qs}`, {
    headers: headers(),
    timeout: 15000,
  });
  return res.data;
}

async function safe(name, fn) {
  try {
    const data = await fn();
    console.log(`   [ok]   ${name}`);
    return { ok: true, data };
  } catch (e) {
    const err = { status: e.response?.status, body: e.response?.data, message: e.message };
    console.log(`   [fail] ${name} -> ${JSON.stringify(err.body || err.message)}`);
    return { ok: false, error: err };
  }
}

// Recursively find any key that looks KYC/verification/status related, with its path.
function findInteresting(obj, out = [], trail = '') {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = trail ? `${trail}.${k}` : k;
    if (/kyc|verif|liveness|face|auth|status|complete/i.test(k) && (v === null || typeof v !== 'object')) {
      out.push(`${p} = ${JSON.stringify(v)}`);
    }
    if (v && typeof v === 'object') findInteresting(v, out, p);
  }
  return out;
}

async function main() {
  console.log(`\n===== SNAPSHOT [${label}] order ${orderNo} @ ${new Date().toISOString()} =====\n`);

  const snapshot = { orderNo, label, capturedAt: new Date().toISOString(), calls: {} };

  // 1. listOrders (find our order in the pending list)
  snapshot.calls.listOrders = await safe('listOrders', () =>
    post(EP.listOrders, {
      orderStatusList: [1, 2, 3, 4],
      tradeType: 'SELL',
      page: 1,
      rows: 100,
    })
  );

  // 2. getUserOrderDetail by orderNumber (the one that works)
  snapshot.calls.getUserOrderDetail = await safe('getUserOrderDetail(orderNumber)', () =>
    post(EP.orderDetail, { orderNumber: orderNo })
  );

  // 3. Chat messages (a "liveness completed" system message may appear here)
  snapshot.calls.chatMessages = await safe('chatMessages', () =>
    get(EP.chatMessages, { orderNo, page: 1, rows: 30, sort: 'desc' })
  );

  // 4. queryUser (buyer/user-level KYC status, if exposed)
  const takerUserNo = snapshot.calls.getUserOrderDetail?.data?.data?.takerUserNo;
  if (takerUserNo) {
    snapshot.calls.queryUser = await safe('queryUser(takerUserNo)', () =>
      post(EP.queryUser, { userNo: takerUserNo })
    );
  }

  // 5. queryCounterPartyOrderStatistic (sometimes reflects verification-related fields)
  snapshot.calls.counterPartyStat = await safe('queryCounterPartyOrderStatistic', () =>
    post(EP.queryCounterPartyOrderStatistic, { orderNumber: orderNo })
  );

  // ---- Highlight KYC-related fields across every call ----
  console.log(`\n--- KYC / verification / status fields found across all calls ---`);
  for (const [callName, result] of Object.entries(snapshot.calls)) {
    if (!result.ok) continue;
    const hits = findInteresting(result.data);
    if (hits.length) {
      console.log(`\n  ${callName}:`);
      hits.forEach(h => console.log(`     ${h}`));
    }
  }

  // Pull the headline value explicitly
  const detail = snapshot.calls.getUserOrderDetail?.data?.data;
  console.log(`\n>>> HEADLINE: getUserOrderDetail.additionalKycVerify = ${detail?.additionalKycVerify}  (orderStatus = ${detail?.orderStatus})`);

  // ---- Save to file ----
  const dir = path.join(__dirname, 'snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let counter = 1;
  let file;
  do {
    file = path.join(dir, `${orderNo}-${label}-${counter}.json`);
    counter++;
  } while (fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  console.log(`\nSaved full snapshot to: ${file}`);
  console.log(`\nRun again with the other label (before/after) and share both files.\n`);
}

main();
