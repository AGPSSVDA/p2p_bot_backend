/**
 * Manually run Method 2 verification for one or all stuck orders.
 *
 * Orders can get stuck in WAITING_DOCUMENTS if they were uploaded while the
 * server wasn't running the Method-2 code. Normally the running server's
 * resumeDocumentCollection() recovers them on startup; this script lets you
 * trigger a verification pass on demand.
 *
 * Usage:
 *   node scripts/run-method2.js <orderNumber>   # one order
 *   node scripts/run-method2.js --all           # every WAITING_DOCUMENTS order
 *
 * This runs the SAME verification the bot runs, but does NOT call
 * verifyOrderInBinance (no side effect) — it only reports the result so you can
 * confirm the documents pass. Restart the actual server to fully complete them.
 */

require('dotenv').config();
const { validateConfig } = require('../src/config/config');
try { validateConfig(); } catch (e) { /* prints feature banner */ }

const { pool } = require('../src/config/mysql');
const m2 = require('../src/seller/services/sellerMethod2Service');
const svc = require('../src/seller/services/sellerBinanceService');

async function kycNameFor(order) {
  if (order.buyer_kyc_name && order.buyer_kyc_name !== '(Unknown)') return order.buyer_kyc_name;
  try {
    const d = await svc.getOrderDetail(order.order_number);
    return d?.buyerName || order.buyer_kyc_name;
  } catch { return order.buyer_kyc_name; }
}

async function runOne(order) {
  const kyc = await kycNameFor(order);
  console.log(`\n${'='.repeat(60)}\n  ${order.order_number}  (KYC: ${kyc})\n${'='.repeat(60)}`);
  const r = await m2.runVerification(order.order_number, kyc);
  console.log(`\n  → RESULT: ${r.status}` + (r.message ? `\n  → MSG: ${r.message}` : ''));
  return r.status;
}

(async () => {
  const arg = process.argv[2];
  let orders;

  if (arg === '--all') {
    const [rows] = await pool.query(
      "SELECT order_number, buyer_kyc_name FROM seller_orders WHERE current_state = 'WAITING_DOCUMENTS'"
    );
    orders = rows;
    console.log(`Found ${orders.length} order(s) in WAITING_DOCUMENTS`);
  } else if (arg) {
    const [rows] = await pool.query(
      'SELECT order_number, buyer_kyc_name FROM seller_orders WHERE order_number = ?', [arg]
    );
    orders = rows;
  } else {
    console.log('Usage: node scripts/run-method2.js <orderNumber> | --all');
    process.exit(1);
  }

  if (!orders.length) { console.log('No matching order.'); process.exit(0); }

  const summary = {};
  for (const o of orders) {
    const status = await runOne(o);
    summary[status] = (summary[status] || 0) + 1;
  }

  console.log(`\n${'='.repeat(60)}\n  SUMMARY: ${JSON.stringify(summary)}\n${'='.repeat(60)}`);
  console.log('\nNOTE: "verified" orders will be completed (verifyOrderInBinance)');
  console.log('by the running server on its next poll / restart.\n');
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
