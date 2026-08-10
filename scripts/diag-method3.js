/**
 * Method 3 diagnostic — run ON THE SERVER: `node scripts/diag-method3.js`
 * Checks env, DB columns, Easebuzz connectivity, and the payment-link build.
 * Prints a clear PASS/FAIL for each so we know exactly what's wrong on the server.
 */
require('dotenv').config();

(async () => {
  const line = (k, ok, extra = '') => console.log(`  ${ok ? '✅' : '❌'} ${k}${extra ? ' — ' + extra : ''}`);

  console.log('\n=== 1) ENV ===');
  line('EASEBUZZ_ENV', !!process.env.EASEBUZZ_ENV, process.env.EASEBUZZ_ENV || 'MISSING');
  line('EASEBUZZ_KEY', !!process.env.EASEBUZZ_KEY, process.env.EASEBUZZ_KEY ? 'set' : 'MISSING');
  line('EASEBUZZ_SALT', !!process.env.EASEBUZZ_SALT, process.env.EASEBUZZ_SALT ? 'set' : 'MISSING');
  line('DB_HOST', !!process.env.DB_HOST, process.env.DB_HOST || 'MISSING');

  console.log('\n=== 2) Easebuzz service loads ===');
  let eb;
  try { eb = require('../src/seller/services/easebuzzService'); line('require easebuzzService', true, 'resolved env=' + eb.env()); }
  catch (e) { line('require easebuzzService', false, e.message); process.exit(1); }

  console.log('\n=== 3) Handler + gateway service load ===');
  try { require('../src/seller/services/paymentGatewayService'); line('paymentGatewayService', true); } catch (e) { line('paymentGatewayService', false, e.message); }
  try { require('../src/seller/bot/sellerOrderHandler'); line('sellerOrderHandler', true); } catch (e) { line('sellerOrderHandler', false, e.message); }

  console.log('\n=== 4) DB Method 3 columns ===');
  try {
    const { pool } = require('../src/config/mysql');
    const [cols] = await pool.query('SHOW COLUMNS FROM seller_orders');
    const n = cols.map((x) => x.Field);
    const need = ['payment_gateway', 'payment_link', 'payment_txn_id', 'payment_easepayid', 'payment_status', 'payment_payer_name', 'crypto_released_at'];
    const missing = need.filter((c) => !n.includes(c));
    line('payment columns', missing.length === 0, missing.length ? 'MISSING: ' + missing.join(',') : 'all present');
  } catch (e) { line('DB check', false, e.message); }

  console.log('\n=== 5) Easebuzz create-link (LIVE call from this server) ===');
  try {
    const r = await eb.createPaymentLink({ orderNo: 'DIAG_' + Date.now(), amount: 1, name: 'Test User', phone: '9999999999' });
    if (r.success && r.link) line('createPaymentLink', true, r.link);
    else line('createPaymentLink', false, r.message || 'no link');
  } catch (e) { line('createPaymentLink', false, e.message); }

  console.log('\nDone.');
  process.exit(0);
})();
