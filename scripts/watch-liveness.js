/**
 * WATCH LIVENESS via the PRODUCTION read path (READ-ONLY, NO SIDE EFFECTS)
 *
 * Uses the same sellerBinanceService.getOrderStatusByOrderNumber() the bot uses,
 * so what you see here is exactly what the poller sees. Polls every 3s and reports
 * additionalKycVerify. Stops when it reaches 2.
 *
 * Usage: node scripts/watch-liveness.js <orderNumber>
 *
 * Run it, then complete the liveness/KYC step on Binance and watch for 1 -> 2.
 */

const svc = require('../src/seller/services/sellerBinanceService');

const orderNo = process.argv[2];
if (!orderNo) {
  console.log('Usage: node scripts/watch-liveness.js <orderNumber>');
  process.exit(1);
}

const POLL_MS = 3000;
let n = 0;
let prev = null;

function ts() {
  return new Date().toISOString().slice(11, 19);
}

async function tick() {
  n++;
  try {
    const r = await svc.getOrderStatusByOrderNumber(orderNo);
    if (!r?.success) {
      console.log(`[${ts()}] Poll #${n}: read failed - ${r?.message || 'unknown'}`);
      return;
    }
    const kyc = r.additionalKycVerify;
    const changed = prev !== null && kyc !== prev;
    console.log(
      `[${ts()}] Poll #${n}: additionalKycVerify=${kyc} orderStatus=${r.orderStatus}` +
        (changed ? `   <<< CHANGED from ${prev}` : '')
    );
    prev = kyc;

    if (kyc === 2) {
      console.log(`\n[${ts()}] ✅ additionalKycVerify = 2 — liveness verified. The poller will detect this. Stopping.\n`);
      process.exit(0);
    }
    if (kyc === 0) {
      console.log(`\n[${ts()}] ℹ️ additionalKycVerify = 0 — KYC not required for this order. Stopping.\n`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`[${ts()}] Poll #${n}: ERROR ${e.message}`);
  }
}

console.log(`\nWatching ${orderNo} via production read path. Poll every ${POLL_MS / 1000}s.`);
console.log(`Complete liveness on Binance and watch for 1 -> 2. Ctrl+C to stop.\n`);
tick();
setInterval(tick, POLL_MS);
