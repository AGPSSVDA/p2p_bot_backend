const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Order States — complete lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const ORDER_STATE = {
  NEW_ORDER:           'NEW_ORDER',
  WAITING_FOR_PAN:     'WAITING_FOR_PAN',
  VALIDATING_PAN:      'VALIDATING_PAN',
  PAN_VERIFIED:        'PAN_VERIFIED',
  WAITING_TDS_CONSENT: 'WAITING_TDS_CONSENT',
  TDS_ACCEPTED:        'TDS_ACCEPTED',
  PROCESSING_PAYMENT:  'PROCESSING_PAYMENT',
  PAYMENT_SENT:        'PAYMENT_SENT',
  WAITING_FOR_RELEASE: 'WAITING_FOR_RELEASE',
  COMPLETED:           'COMPLETED',
  ESCALATED:           'ESCALATED',
  FAILED:              'FAILED',
  CANCELLED:           'CANCELLED',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Order Record Structure
// {
//   orderNo, advOrderNo, state,
//   sellerNickname, sellerUserId,
//   amount (INR), cryptoAmount, asset, fiat,
//   pan, panRetries,
//   payMethods: [...fieldList],
//   selectedPayId,
//   tds: { preTDS, tds, postTDS },
//   payoutId, utr,
//   reminderSent, lastWarningSent,
//   lastMsgId,        ← last seen chat message ID
//   wss: WebSocket,   ← per-order WebSocket connection
//   createdAt, updatedAt
// }
// ─────────────────────────────────────────────────────────────────────────────

class StateManager {
  constructor() {
    this.orders = {};  // keyed by orderNo
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
    return this.orders[orderNo];
  }

  get(orderNo) { return this.orders[orderNo] || null; }

  has(orderNo) { return !!this.orders[orderNo]; }

  incPanRetry(orderNo) {
    if (!this.orders[orderNo]) return 0;
    this.orders[orderNo].panRetries++;
    return this.orders[orderNo].panRetries;
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
