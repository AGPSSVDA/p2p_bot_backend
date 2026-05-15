const axios = require('axios');
const { config }              = require('../config/config');
const { withRetry, formatINR } = require('../utils/helpers');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Razorpay Payout Service
//  Phase 1: no Razorpay → manual alert
//  Phase 3: Razorpay → full auto UPI/IMPS payout
// ─────────────────────────────────────────────────────────────────────────────

function basicAuth() {
  return Buffer
    .from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`)
    .toString('base64');
}

function commonHeaders() {
  return {
    'Authorization': `Basic ${basicAuth()}`,
    'Content-Type':  'application/json',
  };
}

// Idempotency key tied to ORDER (not Date.now()) so retries de-dupe correctly.
function payoutHeaders(orderNo) {
  return {
    ...commonHeaders(),
    'X-Payout-Idempotency': `p2p-payout-${orderNo}`,
  };
}

// ── Create Razorpay Contact ──────────────────────────────────────────────────
async function createContact(name, orderNo) {
  return withRetry(async () => {
    const res = await axios.post(
      `${config.razorpay.baseUrl}/contacts`,
      {
        name:         name || 'P2P Seller',
        type:         'vendor',
        reference_id: `binance_${orderNo}`,
        notes:        { source: 'binance_p2p_bot', orderNo },
      },
      { headers: commonHeaders(), timeout: 15000 }
    );
    logger.info('Razorpay contact created', { contactId: res.data.id, orderNo });
    return res.data.id;
  }, 3, 3000, `createContact:${orderNo}`);
}

// ── Create Fund Account (UPI VPA or Bank) ────────────────────────────────────
async function createFundAccount(contactId, payDetails, orderNo) {
  return withRetry(async () => {
    const isUPI = !!payDetails.upiId;
    const body  = {
      contact_id:   contactId,
      account_type: isUPI ? 'vpa' : 'bank_account',
    };

    if (isUPI) {
      body.vpa = { address: payDetails.upiId };
    } else {
      if (!payDetails.accountNo || !payDetails.ifscCode) {
        throw new Error('Bank account number / IFSC missing in seller payment details');
      }
      body.bank_account = {
        name:           payDetails.accountName,
        ifsc:           payDetails.ifscCode,
        account_number: payDetails.accountNo,
      };
    }

    const res = await axios.post(
      `${config.razorpay.baseUrl}/fund_accounts`,
      body,
      { headers: commonHeaders(), timeout: 15000 }
    );

    logger.info('Razorpay fund account created', {
      fundAccountId: res.data.id,
      type:          isUPI ? 'UPI' : 'Bank',
      orderNo,
    });

    return res.data.id;
  }, 3, 3000, `createFundAccount:${orderNo}`);
}

// ── Send Payout (idempotent per order) ───────────────────────────────────────
async function sendPayout(fundAccountId, amountINR, payDetails, orderNo) {
  if (amountINR > config.bot.maxPaymentAmount) {
    throw new Error(
      `Amount ${formatINR(amountINR)} exceeds safety cap ${formatINR(config.bot.maxPaymentAmount)}`
    );
  }
  if (amountINR <= 0) {
    throw new Error(`Invalid amount: ${amountINR}`);
  }

  const isUPI = !!payDetails.upiId;
  const mode  = isUPI ? 'UPI' : 'IMPS';

  return withRetry(async () => {
    const res = await axios.post(
      `${config.razorpay.baseUrl}/payouts`,
      {
        account_number:       config.razorpay.accountNumber,
        fund_account_id:      fundAccountId,
        amount:               Math.round(amountINR * 100), // paise
        currency:             'INR',
        mode,
        purpose:              'payout',
        queue_if_low_balance: true,
        narration:            `Binance P2P ${orderNo}`.substring(0, 30),
        notes:                { orderNo, source: 'binance_p2p_bot' },
      },
      { headers: payoutHeaders(orderNo), timeout: 20000 }
    );

    const payout = res.data;

    if (payout.status === 'rejected' || payout.status === 'failed') {
      throw new Error(`Payout ${payout.status}: ${payout.failure_reason || 'unknown'}`);
    }

    logger.info('Payout initiated', {
      payoutId: payout.id,
      status:   payout.status,
      mode,
      amount:   amountINR,
      utr:      payout.utr || null,
      orderNo,
    });

    return {
      payoutId: payout.id,
      status:   payout.status,
      mode,
      amount:   amountINR,
      utr:      payout.utr || `PEND-${payout.id || Date.now()}`,
    };
  }, 2, 5000, `sendPayout:${orderNo}`);
}

// ── Master function ──────────────────────────────────────────────────────────
async function processPayment(payDetails, amountINR, orderNo) {
  if (!config.features.autoPayment) {
    logger.info('Auto payment skipped (Phase 1)', { orderNo, amountINR });
    return { manual: true, amount: amountINR, mode: payDetails.methodName };
  }

  logger.info('Starting Razorpay payout', {
    orderNo, amountINR, method: payDetails.methodName,
  });

  const contactId     = await createContact(payDetails.accountName, orderNo);
  const fundAccountId = await createFundAccount(contactId, payDetails, orderNo);
  const result        = await sendPayout(fundAccountId, amountINR, payDetails, orderNo);

  logger.info('Payment complete', { orderNo, ...result });
  return result;
}

module.exports = { processPayment };
