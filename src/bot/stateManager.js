const logger = require('../utils/logger');
const orderDb = require('../services/orderDbService');

// ─────────────────────────────────────────────────────────────────────────────
//  Order States — complete lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const ORDER_STATE = {
  NEW_ORDER:               'NEW_ORDER',
  WAITING_FOR_PAN:         'WAITING_FOR_PAN',
  VALIDATING_PAN:          'VALIDATING_PAN',
  // PAN matched KYC but Surepass bank verification returned a different
  // holder name than the KYC name. Bot asks seller to submit correct bank
  // account number + IFSC in chat. See _handleBankAccountReply.
  WAITING_FOR_BANK_ACCOUNT: 'WAITING_FOR_BANK_ACCOUNT',
  PAN_VERIFIED:            'PAN_VERIFIED',
  WAITING_TDS_CONSENT:     'WAITING_TDS_CONSENT',
  TDS_ACCEPTED:            'TDS_ACCEPTED',
  PROCESSING_PAYMENT:      'PROCESSING_PAYMENT',
  // TDS accepted + payment details captured, but no money has been sent yet
  // (Phase 1, or auto_payout = OFF). Admin must approve from the Payments
  // page to move it to PAYMENT_SENT.
  AWAITING_MANUAL_PAYMENT: 'AWAITING_MANUAL_PAYMENT',
  PAYMENT_SENT:            'PAYMENT_SENT',
  WAITING_FOR_RELEASE:     'WAITING_FOR_RELEASE',
  COMPLETED:               'COMPLETED',
  ESCALATED:               'ESCALATED',
  FAILED:                  'FAILED',
  CANCELLED:               'CANCELLED',
};

class StateManager {
  constructor() {
    this.orders = {};
  }

  add(data) {
    const { orderNo } = data;
    if (this.orders[orderNo]) return this.orders[orderNo];

    this.orders[orderNo] = {
      orderNo,
      advOrderNo:    data.advOrderNo    || data.orderNo,
      state:         ORDER_STATE.NEW_ORDER,
      sellerNickname: data.sellerNickname || 'Seller',
      sellerUserId:  data.sellerUserId  || null,
      amount:        parseFloat(data.amount)       || 0,
      cryptoAmount:  parseFloat(data.cryptoAmount) || 0,
      asset:         data.asset  || 'USDT',
      fiat:          data.fiat   || 'INR',
      pan:           null,
      panRetries:    0,
      // Counter for the "submit correct bank account" retry flow that
      // kicks in when KYC ↔ Bank Holder mismatches but PAN ↔ KYC passes.
      // Capped at config.bot.maxBankRetries (env MAX_BANK_RETRIES, default 2).
      bankRetries:   0,
      payMethods:    [],
      selectedPayId: null,
      tds:           null,
      payoutId:      null,
      utr:           null,
      reminderSent:  false,
      lastWarningSent: false,
      lastMsgId:     null,
      lastOrderStatus: null,
      paymentDetails: null,
      payMethod:     null,
      wss:           null,
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    };

    logger.info('Order registered', {
      orderNo, amount: data.amount, asset: data.asset,
    });

    // Persist to MySQL (best-effort, non-blocking)
    orderDb.upsertOrder(this.orders[orderNo]);
    orderDb.setOrderState(orderNo, null, ORDER_STATE.NEW_ORDER);

    return this.orders[orderNo];
  }

  set(orderNo, newState, extra = {}) {
    if (!this.orders[orderNo]) return null;
    const prev = this.orders[orderNo].state;
    Object.assign(this.orders[orderNo], extra, {
      state:     newState,
      updatedAt: Date.now(),
    });
    logger.info('State change', { orderNo, from: prev, to: newState });

    if (prev !== newState) {
      orderDb.setOrderState(orderNo, prev, newState);
    }

    // Mirror commonly-patched fields into the DB so the frontend reflects them
    const patch = {};
    if (extra.sellerName !== undefined) patch.seller_name = extra.sellerName || null;
    if (extra.sellerUserId !== undefined) patch.seller_user_id = extra.sellerUserId || null;
    if (extra.pan !== undefined) patch.pan = extra.pan || null;
    if (extra.panName !== undefined) patch.pan_name = extra.panName || null;
    if (extra.payoutId !== undefined) patch.payout_id = extra.payoutId || null;
    if (extra.utr !== undefined) patch.utr_number = extra.utr || null;
    if (extra.payMethod !== undefined) patch.payment_method = extra.payMethod || null;

    if (extra.tds) {
      patch.pre_tds_amount = extra.tds.preTDS ?? null;
      patch.tds_amount     = extra.tds.tds ?? null;
      patch.post_tds_amount = extra.tds.postTDS ?? null;
    }

    if (extra.paymentDetails) {
      const pd = extra.paymentDetails;
      patch.payment_method = pd.methodName || patch.payment_method || null;
      patch.upi_id = pd.upiId || null;
      patch.account_no = pd.accountNo || null;
      patch.ifsc_code = pd.ifscCode || null;
      patch.bank_name = pd.bankName || null;
      patch.account_name = pd.accountName || null;
    }

    if (extra.confirmPayEndTime !== undefined && extra.confirmPayEndTime) {
      patch.confirm_pay_end_time = new Date(Number(extra.confirmPayEndTime)).toISOString().slice(0, 19).replace('T', ' ');
    }
    if (extra.notifyPayEndTime !== undefined && extra.notifyPayEndTime) {
      patch.notify_pay_end_time = new Date(Number(extra.notifyPayEndTime)).toISOString().slice(0, 19).replace('T', ' ');
    }

    if (Object.keys(patch).length) {
      orderDb.updateOrder(orderNo, patch);
    }

    return this.orders[orderNo];
  }

  get(orderNo) { return this.orders[orderNo] || null; }

  has(orderNo) { return !!this.orders[orderNo]; }

  incPanRetry(orderNo) {
    if (!this.orders[orderNo]) return 0;
    this.orders[orderNo].panRetries++;
    orderDb.setPanRetries(orderNo, this.orders[orderNo].panRetries);
    return this.orders[orderNo].panRetries;
  }

  // Independent retry counter for the bank-account-resubmit flow. Doesn't
  // touch panRetries because the two flows have different limits and
  // shouldn't share a counter (env MAX_BANK_RETRIES vs MAX_PAN_RETRIES).
  incBankRetry(orderNo) {
    if (!this.orders[orderNo]) return 0;
    this.orders[orderNo].bankRetries = (this.orders[orderNo].bankRetries || 0) + 1;
    return this.orders[orderNo].bankRetries;
  }

  setWss(orderNo, ws) {
    if (this.orders[orderNo]) this.orders[orderNo].wss = ws;
  }

  activeOrders() {
    const done = [
      ORDER_STATE.COMPLETED, ORDER_STATE.CANCELLED,
      ORDER_STATE.FAILED,    ORDER_STATE.ESCALATED,
    ];
    return Object.values(this.orders).filter(o => !done.includes(o.state));
  }

  printStats() {
    const all    = Object.values(this.orders);
    const active = this.activeOrders();
    logger.info('── Bot Stats ──', {
      total:     all.length,
      active:    active.length,
      completed: all.filter(o => o.state === ORDER_STATE.COMPLETED).length,
      states:    active.map(o => `${o.orderNo.slice(-6)}:${o.state}`),
    });
  }
}

const stateManager = new StateManager();
module.exports = { stateManager, ORDER_STATE };
