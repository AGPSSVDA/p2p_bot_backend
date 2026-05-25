const {
  ORDER_STATUS,
  getPendingOrders,
  getChatMessages,
  getOrderDetail,
  markMessagesRead,
} = require('../services/binanceService');
const { chatService }    = require('../services/chatService');
const { orderHandler }   = require('./orderHandler');
const { stateManager, ORDER_STATE } = require('./stateManager');
const binanceSync        = require('../services/binanceSyncService');
const { config }         = require('../config/config');
const logger             = require('../utils/logger');

const TERMINAL_SYNC_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
//  Order Poller — three jobs:
//    1. Detect NEW orders → orderHandler.start()
//    2. Fallback chat polling (when WSS is disconnected)
//    3. Completion polling (Req #6) — detect when seller releases crypto
// ─────────────────────────────────────────────────────────────────────────────

class OrderPoller {
  constructor() {
    this.orderTimer      = null;
    this.chatTimer       = null;
    this.completionTimer = null;
    this.terminalSyncTimer = null;
    this.running         = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.orderTimer = setInterval(
      () => this._pollOrders(), config.bot.orderPollInterval
    );
    this._pollOrders();

    this.chatTimer = setInterval(
      () => this._pollFallbackChats(), config.bot.orderPollInterval + 2000
    );

    this.completionTimer = setInterval(
      () => this._pollCompletion(), config.bot.completionPollInterval
    );

    // Quiet reconciliation: every 5 min, pull recent terminal orders
    // (3 = appealing, 4 = completed, 6/7 = cancelled) from Binance and
    // upsert them so the DB never permanently loses a finished trade.
    this.terminalSyncTimer = setInterval(
      () => this._syncRecentTerminal(), TERMINAL_SYNC_INTERVAL_MS
    );
    // Fire once at startup to catch anything we missed while offline
    setTimeout(() => this._syncRecentTerminal(), 15_000);

    logger.info('OrderPoller started', {
      orderInterval:        config.bot.orderPollInterval,
      completionInterval:   config.bot.completionPollInterval,
      terminalSyncInterval: TERMINAL_SYNC_INTERVAL_MS,
    });
  }

  stop() {
    if (this.orderTimer)         clearInterval(this.orderTimer);
    if (this.chatTimer)          clearInterval(this.chatTimer);
    if (this.completionTimer)    clearInterval(this.completionTimer);
    if (this.terminalSyncTimer)  clearInterval(this.terminalSyncTimer);
    this.running = false;
    logger.info('OrderPoller stopped');
  }

  // ── 1. Detect new orders ──────────────────────────────────────────────────
  async _pollOrders() {
    try {
      const orders = await getPendingOrders();

      for (const raw of orders) {
        const orderNo = raw.orderNumber || raw.adOrderNo || raw.orderNo;
        if (!orderNo) continue;
        if (stateManager.has(orderNo)) continue;

        // Only act on orders awaiting payment (not already-paid orders that
        // got picked up by listOrders status=2)
        const status = Number(raw.orderStatus);
        if (status && status !== ORDER_STATUS.WAIT_PAYMENT) {
          logger.debug('Skipping order — not awaiting payment', { orderNo, status });
          continue;
        }

        logger.info('New order detected via polling', {
          orderNo,
          amount: raw.totalPrice || raw.amount,
          asset:  raw.asset,
        });

        await orderHandler.start(raw);
      }

    } catch (err) {
      logger.error('OrderPoller._pollOrders error', { error: err.message });
    }
  }

  // ── 2. Fallback chat polling (when WSS not connected) ─────────────────────
  async _pollFallbackChats() {
    const active = stateManager.activeOrders();

    for (const order of active) {
      const { orderNo } = order;

      if (chatService.connections[orderNo]) continue; // WSS live → skip

      // Skip terminal/processing states
      if ([
        ORDER_STATE.PROCESSING_PAYMENT,
        ORDER_STATE.PAYMENT_SENT,
        ORDER_STATE.COMPLETED,
        ORDER_STATE.CANCELLED,
        ORDER_STATE.ESCALATED,
        ORDER_STATE.FAILED,
      ].includes(order.state)) continue;

      try {
        const messages = await getChatMessages(orderNo, order.lastMsgId || null);
        if (!messages || messages.length === 0) continue;

        const newMsgs = order.lastMsgId
          ? messages.filter(m => (m.msgId || m.uuid || m.id) > order.lastMsgId)
          : messages;

        if (newMsgs.length === 0) continue;

        const latest = newMsgs[newMsgs.length - 1];
        const latestId = latest.msgId || latest.uuid || latest.id;
        if (latestId) {
          stateManager.set(orderNo, order.state, { lastMsgId: latestId });
        }

        for (const m of newMsgs) {
          // Strict: only process messages explicitly from the seller.
          //   self !== false → skip (covers our own + unknown origin + system)
          if (m.self !== false) continue;
          if (m.senderType === 'SYSTEM' || m.msgType === 'SYSTEM') continue;

          const type = String(m.type || m.msgType || 'text').toLowerCase();
          const content = m.content || m.message || m.msg || '';
          if (!content && type === 'text') continue;

          // Shared dedup: if the WSS already processed this msgId, skip
          // the REST copy. Covers the WSS→REST race during reconnects.
          const restMsgId = m.msgId || m.uuid || m.id;
          if (chatService._alreadySeen(orderNo, restMsgId)) {
            continue;
          }

          await orderHandler._onMessage(orderNo, {
            type,
            content,
            msgId:    m.msgId || m.uuid || m.id,
            senderId: m.sendUserId || m.userId || '',
            raw:      m,
          });
        }

        markMessagesRead(orderNo).catch(() => {});

      } catch (err) {
        logger.error('Fallback chat poll error', { orderNo, error: err.message });
      }
    }
  }

  // ── 3. Completion polling (Req #6) ────────────────────────────────────────
  //   For orders bot has paid for, check if seller has released crypto.
  //   Fires the thank-you message when status flips to COMPLETED.
  //
  //   ALSO watches ESCALATED orders that have a payoutId — defensive
  //   recovery. If something escalated an order AFTER we'd already sent
  //   payment (e.g. a stale keyword check, an admin click, a transient
  //   bug), we still need to detect the seller's crypto release so the
  //   order doesn't sit in ESCALATED forever and THANK_YOU still fires.
  async _pollCompletion() {
    const watchStates = [
      ORDER_STATE.WAITING_FOR_RELEASE,
      ORDER_STATE.PAYMENT_SENT,
    ];

    const watching = Object.values(stateManager.orders)
      .filter(o =>
        watchStates.includes(o.state) ||
        // Escalated AFTER payment was sent — keep watching for completion.
        // Either payoutId (Cashfree auto-pay) OR a real (non-PEND-) UTR
        // (manual approval) proves money has left, so the seller MAY still
        // release crypto and we must catch the COMPLETED transition.
        (o.state === ORDER_STATE.ESCALATED &&
         (o.payoutId || (o.utr && !String(o.utr).startsWith('PEND-'))))
      );

    for (const order of watching) {
      const { orderNo } = order;
      try {
        const detail = await getOrderDetail(orderNo);
        const status = Number(detail.orderStatus);
        if (!status) continue;

        // Persist last-known status
        stateManager.set(orderNo, order.state, { lastOrderStatus: status });

        if (status === ORDER_STATUS.COMPLETED) {
          await orderHandler._onOrderStatusChange(orderNo, status);
        } else if (
          status === ORDER_STATUS.CANCELLED ||
          status === ORDER_STATUS.SYS_CANCELLED ||
          status === ORDER_STATUS.APPEALING
        ) {
          await orderHandler._onOrderStatusChange(orderNo, status);
        }

      } catch (err) {
        logger.warn('Completion poll error', { orderNo, error: err.message });
      }
    }
  }
}

// ── 4. Periodic terminal-order sync ─────────────────────────────────────────
//   Fires every TERMINAL_SYNC_INTERVAL_MS. Pulls one page each of status
//   3/4/6/7 from Binance and upserts into MySQL via binanceSync. Catches
//   any order that completed/cancelled while the bot was offline or that
//   the live poller missed because it was already past status 1.
OrderPoller.prototype._syncRecentTerminal = async function () {
  try {
    const result = await binanceSync.quickSyncTerminal();
    if (result.total > 0) {
      logger.info('Periodic terminal sync upserted orders', {
        total: result.total,
        perStatus: result.perStatus,
      });
    }
  } catch (err) {
    logger.warn('Periodic terminal sync failed', { error: err.message });
  }
};

const orderPoller = new OrderPoller();
module.exports = { orderPoller };
