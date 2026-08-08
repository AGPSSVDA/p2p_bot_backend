/**
 * Easebuzz payment gateway — Method 3 payment step.
 *
 * Two operations we use:
 *   1) createPaymentLink() — EasyCollect API: makes a one-time payment link (the
 *      hosted page also shows a UPI QR) for the exact order amount.
 *      POST {dashboard}/easycollect/v1/create   (JSON)
 *      hash = sha512(key|merchant_txn|name|email|phone|amount|udf1|udf2|udf3|udf4|udf5|message|SALT)
 *   2) getTransaction() — Transaction v2 API: fetches payment status + payer info
 *      (used to confirm the buyer actually paid, and read the payer name).
 *      POST {dashboard}/transaction/v2/retrieve   (x-www-form-urlencoded)
 *      hash = sha512(key|txnid|SALT)
 *
 * Env:
 *   EASEBUZZ_KEY    merchant key
 *   EASEBUZZ_SALT   merchant salt
 *   EASEBUZZ_ENV    'test' (default) | 'prod'
 *
 * NOTE on payer name: for CARD payments the response carries `name_on_card`; for
 * UPI, NPCI privacy means the payer's real bank name is usually NOT returned
 * (`name_on_card` empty, `firstname` is the name WE supplied). The caller handles
 * the "no payer name" case.
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../utils/logger');

function env() {
  // Accept prod / production / live (all mean the production endpoint).
  const v = (process.env.EASEBUZZ_ENV || 'test').toLowerCase();
  return (v === 'prod' || v === 'production' || v === 'live') ? 'prod' : 'test';
}

function dashboardBase() {
  return env() === 'prod' ? 'https://dashboard.easebuzz.in/' : 'https://testdashboard.easebuzz.in/';
}

function sha512(str) {
  return crypto.createHash('sha512').update(str).digest('hex');
}

function creds() {
  const key = process.env.EASEBUZZ_KEY;
  const salt = process.env.EASEBUZZ_SALT;
  return { key, salt, ok: !!(key && salt) };
}

/**
 * Normalise a payer name from the gateway. Easebuzz returns placeholder junk for
 * UPI ("NA", "N/A", "-", "null", empty). Return null for anything that isn't a
 * real name so the caller skips name-matching (UPI has no reliable payer name).
 */
function cleanPayerName(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (!s) return null;
  const junk = new Set(['na', 'n/a', 'null', 'none', '-', 'nil', 'undefined']);
  if (junk.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Create a payment link (EasyCollect) for the exact order amount.
 * @param {object} p { orderNo, amount, name, phone, email }
 * @returns {Promise<{success, link?, qr?, merchantTxn?, message?, raw?}>}
 */
async function createPaymentLink({ orderNo, amount, name, phone, email }) {
  const { key, salt, ok } = creds();
  if (!ok) return { success: false, message: 'Easebuzz not configured (EASEBUZZ_KEY/SALT)' };

  const amt = Number(amount).toFixed(2);
  const merchantTxn = `SELL_${orderNo}_${String(Date.now()).slice(-6)}`;
  const cname = (name && name !== '(Unknown)') ? name : 'Customer';
  // Easebuzz requires a 10-digit phone; use a safe placeholder if we don't have one.
  const cphone = /^\d{10}$/.test(String(phone || '')) ? String(phone) : '9999999999';
  const cemail = email || 'noreply@example.com';
  // Show the Binance order number on the Easebuzz payment page ("Message" field).
  const message = `Order ${orderNo}`;

  // Hash: key|merchant_txn|name|email|phone|amount|udf1|udf2|udf3|udf4|udf5|message|SALT
  const hashStr = [key, merchantTxn, cname, cemail, cphone, amt, '', '', '', '', '', message, salt].join('|');
  const hash = sha512(hashStr);

  const body = {
    key,
    hash,
    name: cname,
    phone: cphone,
    email: cemail,
    amount: amt,
    merchant_txn: merchantTxn,
    message,
  };

  try {
    const res = await axios.post(`${dashboardBase()}easycollect/v1/create`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    const data = res.data;
    const status = data?.status === 1 || data?.status === '1' || data?.status === true;
    if (!status) {
      logger.warn('Easebuzz createPaymentLink failed', { orderNo, resp: JSON.stringify(data).slice(0, 200) });
      return { success: false, message: data?.data || data?.message || 'link creation failed', raw: data };
    }
    // The link is in data.data (URL) — the hosted page shows a UPI QR too.
    const d = data.data || {};
    const link = d.payment_url || d.url || d.link || (typeof data.data === 'string' ? data.data : null);
    logger.info('Easebuzz payment link created', { orderNo, merchantTxn });
    return { success: true, link, qr: d.qr_code || null, merchantTxn, raw: data };
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Easebuzz createPaymentLink error', { orderNo, detail: typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail).slice(0, 200) });
    return { success: false, message: err.message };
  }
}

/**
 * Fetch a transaction's status + payer details by our merchant txn id.
 * @returns {Promise<{success, paid, status?, amount?, easepayid?, payerName?, mode?, raw?, message?}>}
 */
async function getTransaction(merchantTxn) {
  const { key, salt, ok } = creds();
  if (!ok) return { success: false, message: 'Easebuzz not configured' };

  const hash = sha512([key, merchantTxn, salt].join('|'));
  const form = new URLSearchParams({ key, txnid: merchantTxn, hash });

  try {
    const res = await axios.post(`${dashboardBase()}transaction/v2/retrieve`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    });
    const data = res.data;
    // Response shape: { status: true, msg: {...} } or { status: 1, data: [...] }
    const txn = Array.isArray(data?.msg) ? data.msg[0]
      : (Array.isArray(data?.data) ? data.data[0] : (data?.msg || data?.data || data));
    if (!txn) return { success: true, paid: false, raw: data };

    const st = String(txn.status || '').toLowerCase();
    const paid = st === 'success' || st === 'paid' || st === 'completed';
    // Payer name: card → name_on_card. For UPI, Easebuzz returns no real payer
    // name — often the literal "NA"/"N/A" or our own supplied firstname. Treat
    // those as "not available" so we don't false-mismatch (see verifyPaymentAndRelease).
    const raw = txn.name_on_card || txn.payer_name || null; // do NOT use firstname (that's what WE sent)
    const cleaned = cleanPayerName(raw);

    return {
      success: true,
      paid,
      status: txn.status,
      amount: txn.amount != null ? Number(txn.amount) : null,
      easepayid: txn.easepayid || null,
      payerName: cleaned,
      mode: txn.mode || txn.payment_source || null,
      raw: txn,
    };
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Easebuzz getTransaction error', { merchantTxn, detail: typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail).slice(0, 200) });
    return { success: false, message: err.message };
  }
}

module.exports = { createPaymentLink, getTransaction, env };
