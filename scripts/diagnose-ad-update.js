/**
 * DIAGNOSE AD UPDATE FAILURE (error -9000 / 187022)
 *
 * Uses the SELLER keys (via sellerBinanceConfig) — the exact same credentials the
 * production eligibility sync uses. No buyer keys involved.
 *
 * Isolates WHY /sapi/v1/c2c/ads/update fails for a given ad by testing, in order:
 *   1. Read the ad + show its current eligibility values
 *   2. Bare update (advNo only, no fields)      -> is the AD itself blocked?
 *   3. Each eligibility field ONE AT A TIME     -> which field is rejected?
 *   4. The exact payload the production sync sends
 *   5. Control: other ads on the same account   -> is it this ad, or the code?
 *
 * Usage:
 *   node scripts/diagnose-ad-update.js [adNo]
 * Default adNo: 13900814235866066944
 *
 * SAFE: each test sends only the field under test, using the ad's CURRENT value
 * where possible, so successful calls are effectively no-ops.
 */

const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../src/config/sellerBinanceConfig');

const AD_NO = process.argv[2] || '13900814235866066944';
const BASE = cfg.baseUrl;

if (!cfg.apiKey || !cfg.secretKey) {
  console.error('❌ Seller keys missing. Set BINANCE_SELLER_API_KEY / BINANCE_SELLER_SECRET_KEY in .env');
  process.exit(1);
}

function bsq(params = {}) {
  const a = { ...params, timestamp: Date.now() };
  const q = Object.entries(a)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${q}&signature=${crypto.createHmac('sha256', cfg.secretKey).update(q).digest('hex')}`;
}

const hdr = () => ({
  'X-MBX-APIKEY': cfg.apiKey,
  'Content-Type': 'application/json',
  clientType: 'PC',
});

async function getAdDetail(adsNo) {
  const r = await axios.post(
    `${BASE}/sapi/v1/c2c/ads/getDetailByNo?${bsq({ adsNo })}`,
    { adsNo },
    { headers: hdr(), timeout: 12000 }
  );
  return r.data?.data || r.data;
}

async function tryUpdate(body) {
  try {
    const r = await axios.post(
      `${BASE}/sapi/v1/c2c/ads/update?${bsq({})}`,
      body,
      { headers: hdr(), timeout: 12000 }
    );
    return { ok: true, code: r.data?.code };
  } catch (e) {
    return {
      ok: false,
      code: e.response?.data?.code,
      msg: e.response?.data?.msg,
    };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  AD UPDATE DIAGNOSTIC — ad ${AD_NO}`);
  console.log(`  Using SELLER key: ${cfg.apiKey.slice(0, 10)}...  (same as production sync)`);
  console.log(`${'='.repeat(72)}`);

  // ---- STEP 1: read the ad ----
  console.log(`\n--- STEP 1: read the ad with the seller key ---`);
  let detail;
  try {
    detail = await getAdDetail(AD_NO);
    console.log(`  ✅ Can read ad (advStatus=${detail.advStatus}, asset=${detail.asset}, tradeType=${detail.tradeType})`);
  } catch (e) {
    console.log(`  ❌ Cannot read ad: ${JSON.stringify(e.response?.data || e.message)}`);
    console.log(`     -> The seller key may not own this ad. Stopping.`);
    process.exit(1);
  }

  console.log(`\n  Current eligibility values on the ad:`);
  [
    'advStatus',
    'userTradeCompleteCountMin', 'userTradeCountFilterTime',
    'userTradeCompleteRateMin', 'userTradeCompleteRateFilterTime',
    'buyerRegDaysLimit', 'userAllTradeCountMin', 'userAllTradeCountMax',
    'userBuyTradeCountMin', 'userSellTradeCountMin',
    'userTradeVolumeMin', 'userTradeVolumeMax', 'userTradeVolumeAsset',
    'userTradeVolumeFilterTime', 'buyerBtcPositionLimit', 'buyerKycLimit',
    'takerAdditionalKycRequired',
  ].forEach(k => console.log(`     ${k.padEnd(34)} = ${JSON.stringify(detail[k])}`));

  // ---- STEP 2: bare update ----
  console.log(`\n--- STEP 2: bare update (advNo only, nothing changed) ---`);
  console.log(`  If this FAILS, the ad itself is blocked — not the payload.`);
  const bare = await tryUpdate({ advNo: AD_NO });
  console.log(`  -> ${bare.ok ? `✅ SUCCESS code=${bare.code}` : `❌ FAIL code=${bare.code} msg=${bare.msg}`}`);
  await sleep(600);

  // ---- STEP 3: one field at a time ----
  console.log(`\n--- STEP 3: each field individually ---`);
  console.log(`  Reveals exactly which field/value Binance rejects, if any.\n`);

  const fieldTests = [
    // field names the production sync currently sends:
    ['userTradeCountMin  (sync sends this)',   { userTradeCountMin: 0 }],
    ['buyerRegisterLimit (sync sends this)',   { buyerRegisterLimit: 0 }],
    // documented / real field names from the live ad:
    ['userTradeCompleteCountMin (doc name)',   { userTradeCompleteCountMin: 0 }],
    ['buyerRegDaysLimit (doc name)',           { buyerRegDaysLimit: -1 }],
    ['userTradeCompleteRateMin',               { userTradeCompleteRateMin: 0 }],
    ['userAllTradeCountMin',                   { userAllTradeCountMin: 0 }],
    ['userBuyTradeCountMin',                   { userBuyTradeCountMin: 0 }],
    ['userSellTradeCountMin',                  { userSellTradeCountMin: 0 }],
    ['userTradeVolumeMin',                     { userTradeVolumeMin: 0 }],
    ['userTradeVolumeMax',                     { userTradeVolumeMax: 0 }],
    ['buyerBtcPositionLimit',                  { buyerBtcPositionLimit: 0 }],
    ['takerAdditionalKycRequired (unchanged)', { takerAdditionalKycRequired: detail.takerAdditionalKycRequired }],
  ];

  for (const [label, fields] of fieldTests) {
    const r = await tryUpdate({ advNo: AD_NO, ...fields });
    console.log(`  ${label.padEnd(42)} ${r.ok ? '✅ SUCCESS' : `❌ FAIL ${r.code}/${r.msg}`}`);
    await sleep(600);
  }

  // ---- STEP 4: exact production payload ----
  console.log(`\n--- STEP 4: exact payload the production sync sends ---`);
  const prodPayload = {
    advNo: AD_NO,
    userTradeCountMin: 0,
    userTradeCompleteRateMin: 0,
    buyerRegisterLimit: 0,
    userAllTradeCountMin: 0,
    userBuyTradeCountMin: 0,
    userSellTradeCountMin: 0,
    userTradeVolumeMin: 0,
    userTradeVolumeMax: 0,
    buyerBtcPositionLimit: 0,
  };
  console.log(`  ${JSON.stringify(prodPayload)}`);
  const prod = await tryUpdate(prodPayload);
  console.log(`  -> ${prod.ok ? '✅ SUCCESS' : `❌ FAIL code=${prod.code} msg=${prod.msg}`}`);

  // ---- STEP 5: control ads ----
  console.log(`\n--- STEP 5: control — do OTHER ads on this account accept the same call? ---`);
  try {
    const listRes = await axios.post(
      `${BASE}${cfg.endpoints.searchMyAds}?${bsq({})}`,
      { page: 1, rows: 20 },
      { headers: hdr(), timeout: 15000 }
    );
    const d = listRes.data?.data || listRes.data;
    const ads = Array.isArray(d) ? d : d?.list || d?.data || [];
    const others = ads.map(a => a.advNo || a.adsNo).filter(n => n && n !== AD_NO).slice(0, 3);
    for (const other of others) {
      const r = await tryUpdate({ advNo: other });
      console.log(`  control ad ${other}: ${r.ok ? '✅ SUCCESS' : `❌ FAIL ${r.code}/${r.msg}`}`);
      await sleep(600);
    }
    if (!others.length) console.log('  (no other ads found to compare)');
  } catch (e) {
    console.log(`  could not list ads: ${JSON.stringify(e.response?.data || e.message)}`);
  }

  // ---- VERDICT ----
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  HOW TO READ THIS`);
  console.log(`${'='.repeat(72)}`);
  console.log(`
  • STEP 2 bare update FAILS  +  STEP 5 control ads SUCCEED
      -> THIS AD is blocked by Binance. Not your code, not the payload.
         Open the ad in the Binance P2P web UI and try editing it by hand —
         the UI shows the real reason. Error 187022 is undocumented.

  • STEP 2 SUCCEEDS but a STEP 3 field FAILS
      -> That specific field/value is the problem. Fix that field.

  • Everything SUCCEEDS now
      -> It was transient (Binance throttle / temporary lock). Retry the sync.
`);

  process.exit(0);
})().catch(e => {
  console.error('Fatal:', e.response?.data || e.message);
  process.exit(1);
});
