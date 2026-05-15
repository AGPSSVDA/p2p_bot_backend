const { stateManager, ORDER_STATE } = require('./stateManager');
const { MESSAGES }                  = require('./messages');
const { chatService }               = require('../services/chatService');
const { verifyPAN }                 = require('../services/panService');
const { processPayment }            = require('../services/paymentService');
const {
  ORDER_STATUS,
  CANCEL_REASON,
  getOrderDetail,
  getChatCredential,
  extractPaymentDetails,
  markOrderAsPaid,
  markMessagesRead,
  cancelOrder,
  canCancelOrder,
} = require('../services/binanceService');
const {
  extractPAN,
  isProblemMessage,
  isAgreementMessage,
  maskPAN,
  calculateTDS,
  matchNames,
  formatINR,
  sleep,
} = require('../utils/helpers');
const { config } = require('../config/config');
const logger     = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Order Handler — full lifecycle of one P2P order
//    new → welcome → PAN ask → PAN verify → TDS → consent
//        → payment → markPaid → wait release → thank-you
// ─────────────────────────────────────────────────────────────────────────────

class OrderHandler {

  // ── Entry point ───────────────────────────────────────────────────────────
  async start(rawOrder) {
    const orderNo = rawOrder.orderNumber || rawOrder.adOrderNo || rawOrder.orderNo;
    if (!orderNo) return;
    if (stateManager.has(orderNo)) return;

    stateManager.add({
      orderNo,
      advOrderNo:     rawOrder.adOrderNo || orderNo,
      sellerNickname: rawOrder.counterPartNickName || rawOrder.sellerNickname || 'Seller',
      sellerUserId:   rawOrder.counterPartUserId || null,
      amount:         rawOrder.totalPrice  || rawOrder.amount       || 0,
      cryptoAmount:   rawOrder.amount      || rawOrder.cryptoAmount || 0,
      asset:          rawOrder.asset       || 'USDT',
      fiat:           rawOrder.fiat        || 'INR',
    });

    logger.info('New order — starting handler', { orderNo });

    await this._connectChat(orderNo);

    // Prefetch order detail to capture seller's KYC name + bank details for
    // PAN name-match later. Non-blocking — failure is logged but flow continues.
    this._prefetchOrderDetail(orderNo).catch(() => {});

    const order = stateManager.get(orderNo);

    // Req #1: configurable welcome + PAN-request message
    await this._send(orderNo, MESSAGES.WELCOME(order.sellerNickname, order.amount, order.asset));
    await sleep(1500);
    await this._send(orderNo, MESSAGES.PAN_REQUEST());

    stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
    this._startPANTimer(orderNo);
  }

  // ── Prefetch order detail for sellerName + payment info + deadlines ───────
  async _prefetchOrderDetail(orderNo) {
    try {
      const detail = await getOrderDetail(orderNo);
      const sellerName = (detail.sellerName || detail.sellerRealName || '').trim();
      let paymentDetails = null;
      try { paymentDetails = extractPaymentDetails(detail); } catch (e) {}

      const confirmPayEndTime = Number(detail.confirmPayEndTime) || null;
      const notifyPayEndTime  = Number(detail.notifyPayEndTime)  || null;

      // Capture seller's userId from any of the possible field names so we can
      // strictly filter incoming messages to seller-only later.
      const cur = stateManager.get(orderNo);
      const sellerUserId = String(
        detail.counterPartUserId
        || detail.sellerUserId
        || detail.sellerId
        || cur?.sellerUserId
        || ''
      ) || null;

      stateManager.set(orderNo, cur.state, {
        sellerName,
        sellerUserId,
        paymentDetails,
        payMethod: paymentDetails?.methodName || null,
        confirmPayEndTime,
        notifyPayEndTime,
      });

      logger.info('Order detail prefetched', {
        orderNo,
        sellerName:        sellerName || '(none)',
        sellerUserId:      sellerUserId || '(unknown)',
        bankName:          paymentDetails?.accountName || '(none)',
        method:            paymentDetails?.methodName || '(none)',
        confirmPayEndTime: confirmPayEndTime ? new Date(confirmPayEndTime).toISOString() : null,
        notifyPayEndTime:  notifyPayEndTime  ? new Date(notifyPayEndTime).toISOString()  : null,
      });

      // Schedule auto-cancel based on Binance's own deadline
      this._scheduleAutoCancel(orderNo);
    } catch (err) {
      logger.warn('Order detail prefetch failed (will retry at payment time)', {
        orderNo, error: err.message,
      });
    }
  }

  // ── Auto-cancel scheduling — fire `bufferMs` BEFORE Binance's deadline ────
  _scheduleAutoCancel(orderNo) {
    const buffer = config.bot.autoCancelBufferMs;
    if (!buffer || buffer < 0) return;          // disabled

    const order = stateManager.get(orderNo);
    if (!order) return;

    // Use the EARLIER of the two deadlines (whichever Binance enforces first)
    const deadlines = [order.confirmPayEndTime, order.notifyPayEndTime].filter(Boolean);
    if (!deadlines.length) {
      logger.debug('No deadline known yet for auto-cancel', { orderNo });
      return;
    }
    const earliest = Math.min(...deadlines);
    const cancelAt = earliest - buffer;
    const ms       = cancelAt - Date.now();

    if (!this._cancelTimers) this._cancelTimers = {};
    // Clear any previous timer for this order
    if (this._cancelTimers[orderNo]) {
      clearTimeout(this._cancelTimers[orderNo]);
      delete this._cancelTimers[orderNo];
    }

    if (ms <= 0) {
      logger.warn('Order deadline already too close — cancelling immediately', { orderNo });
      this._autoCancel(orderNo, 'Deadline reached on prefetch').catch(() => {});
      return;
    }

    logger.info('Auto-cancel scheduled', {
      orderNo,
      fireAt:    new Date(cancelAt).toISOString(),
      inSeconds: Math.round(ms / 1000),
      bufferMs:  buffer,
    });

    this._cancelTimers[orderNo] = setTimeout(
      () => this._autoCancel(orderNo, 'Pre-deadline auto-cancel').catch(e => {
        logger.error('Auto-cancel failed', { orderNo, error: e.message });
      }),
      ms
    );
  }

  // ── Actually call Binance cancel API (with safety guards) ─────────────────
  //
  //   Strategy (per user request — use "Due to seller" reason category so
  //   buyer's cancellation rate is NOT impacted, and seller-acceptance flow
  //   is triggered by Binance internally):
  //
  //   We use reasonCode = 6 ("Seller cannot release") for all auto-cancels.
  //   v7.4 docs name it for post-payment scenarios but it's the only
  //   documented "Due to seller" code that semantically covers "seller
  //   failed to do their part" (no response, deadline missed, etc).
  //   The actual context goes into additionalInfo so it's visible.
  //
  //   reason = freeform string for our logs and Binance additionalInfo
  async _autoCancel(orderNo, reason) {
    const order = stateManager.get(orderNo);
    if (!order) return;

    // CRITICAL: never cancel after we've paid or are mid-payment
    const unsafe = [
      ORDER_STATE.PROCESSING_PAYMENT,
      ORDER_STATE.PAYMENT_SENT,
      ORDER_STATE.WAITING_FOR_RELEASE,
      ORDER_STATE.COMPLETED,
      ORDER_STATE.CANCELLED,
    ];
    if (unsafe.includes(order.state)) {
      logger.warn('Auto-cancel skipped — past safe point', {
        orderNo, state: order.state, reason,
      });
      return;
    }

    // Pre-check with Binance (defensive — order may have been marked paid by
    // another path or already cancelled by seller in the last second).
    const allowed = await canCancelOrder(orderNo);
    if (!allowed) {
      logger.warn('Binance says cancel not allowed — skipping API call', {
        orderNo, state: order.state, reason,
      });
      stateManager.set(orderNo, ORDER_STATE.CANCELLED);
      this._clearCancelTimer(orderNo);
      chatService.disconnect(orderNo);
      return;
    }

    // "Due to seller" reason — seller-fault attribution, doesn't hurt our rate
    const reasonCode = CANCEL_REASON.SELLER_CANNOT_RELEASE; // = 6
    const additionalInfo = `No response from seller — ${reason || 'auto-cancel'}`;

    logger.warn('Auto-cancelling order on Binance (Due to seller flow)', {
      orderNo, state: order.state, reason,
      reasonCode, additionalInfo,
    });

    try {
      await this._send(orderNo, MESSAGES.ORDER_CANCELLED());
    } catch (e) { /* chat may already be down */ }

    try {
      await cancelOrder(orderNo, reasonCode, additionalInfo);
      stateManager.set(orderNo, ORDER_STATE.CANCELLED);
      logger.warn('Cancellation request sent to Binance', {
        orderNo,
        note: 'Per v7.4: code 6 = "Due to seller" → may require seller to accept',
      });
    } catch (err) {
      logger.error('Binance cancelOrder failed — marking locally cancelled', {
        orderNo, error: err.message,
      });
      stateManager.set(orderNo, ORDER_STATE.CANCELLED);
    }

    this._clearCancelTimer(orderNo);
    chatService.disconnect(orderNo);
  }

  _clearCancelTimer(orderNo) {
    if (this._cancelTimers?.[orderNo]) {
      clearTimeout(this._cancelTimers[orderNo]);
      delete this._cancelTimers[orderNo];
    }
  }

  // ── Connect WebSocket ─────────────────────────────────────────────────────
  async _connectChat(orderNo) {
    try {
      const credential = await getChatCredential(orderNo);
      stateManager.setWss(orderNo, credential);

      await chatService.connect(
        orderNo, credential,
        (msg) => this._onMessage(orderNo, msg)
      );
    } catch (err) {
      logger.error('Failed to connect chat WSS — fallback polling will handle', {
        orderNo, error: err.message,
      });
    }
  }

  // ── Unified message handler — receives `{ type, content, msgId }` ────────
  //    Called by chatService (WSS) AND by orderPoller fallback (REST).
  async _onMessage(orderNo, msg) {
    const order = stateManager.get(orderNo);
    if (!order) return;

    // Order-status push from WSS — Req #6 trigger
    if (msg.type === 'order_status') {
      await this._onOrderStatusChange(orderNo, msg.orderStatus);
      return;
    }

    // Image / video / file → can't read, ask for text
    if (msg.type === 'image' || msg.type === 'video' || msg.type === 'file') {
      if (order.state === ORDER_STATE.WAITING_FOR_PAN) {
        await this._send(orderNo, MESSAGES.PAN_IMAGE_REJECTED());
      }
      return;
    }

    // From here on: text only
    if (msg.type !== 'text') return;
    const text = String(msg.content || '');
    if (!text.trim()) return;

    // STRICT seller-only check: if we know the seller's userId AND the
    // incoming message has a senderId, they must match. This prevents
    // accidentally treating an admin/buyer-side message as a seller reply.
    if (order.sellerUserId && msg.senderId &&
        String(msg.senderId) !== String(order.sellerUserId)) {
      logger.info('Ignoring non-seller message', {
        orderNo,
        msgSenderId:  msg.senderId,
        knownSeller:  order.sellerUserId,
        preview:      text.substring(0, 60),
      });
      return;
    }

    // Skip terminal states
    const terminal = [
      ORDER_STATE.COMPLETED, ORDER_STATE.CANCELLED,
      ORDER_STATE.FAILED,    ORDER_STATE.ESCALATED,
    ];
    if (terminal.includes(order.state)) return;

    markMessagesRead(orderNo).catch(() => {});

    logger.info('Incoming message', {
      orderNo, state: order.state, preview: text.substring(0, 70),
    });

    if (isProblemMessage(text)) {
      await this._escalate(orderNo, `Problem keyword: "${text.substring(0, 80)}"`);
      return;
    }

    switch (order.state) {
      case ORDER_STATE.WAITING_FOR_PAN:
        await this._handlePANReply(orderNo, text);
        break;

      case ORDER_STATE.WAITING_TDS_CONSENT:
        await this._handleTDSConsent(orderNo, text);
        break;

      case ORDER_STATE.PAN_VERIFIED:
      case ORDER_STATE.TDS_ACCEPTED:
      case ORDER_STATE.PROCESSING_PAYMENT:
      case ORDER_STATE.VALIDATING_PAN:
        await this._send(orderNo, MESSAGES.WAIT_PROCESSING());
        break;

      case ORDER_STATE.PAYMENT_SENT:
      case ORDER_STATE.WAITING_FOR_RELEASE:
        await this._send(orderNo, MESSAGES.WAIT_RELEASE(order.payMethod));
        break;

      default:
        await this._send(orderNo, MESSAGES.PAN_NOT_FOUND());
    }
  }

  // ── Handle PAN reply ──────────────────────────────────────────────────────
  async _handlePANReply(orderNo, text) {
    const pan = extractPAN(text);

    if (!pan) {
      await this._send(orderNo, MESSAGES.PAN_NOT_FOUND());
      return;
    }

    logger.info('PAN extracted', { orderNo, pan: maskPAN(pan) });
    stateManager.set(orderNo, ORDER_STATE.VALIDATING_PAN, { pan });

    try {
      const result = await verifyPAN(pan);

      if (!result.valid) {
        const retries = stateManager.incPanRetry(orderNo);
        logger.warn('PAN invalid', {
          orderNo, pan: maskPAN(pan), source: result.source, reason: result.reason, retries,
        });

        if (retries >= config.bot.maxPanRetries) {
          await this._send(orderNo, MESSAGES.PAN_MAX_RETRIES());
          await this._escalate(orderNo, `Max PAN retries (${retries})`);
        } else {
          stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
          // Route by failure source so seller sees the most actionable message
          if (result.source === 'format') {
            await this._send(orderNo, MESSAGES.PAN_INVALID_FORMAT());
          } else {
            await this._send(orderNo, MESSAGES.PAN_API_INVALID(result.reason));
          }
        }
        return;
      }

      // PAN valid — verify name match against Binance KYC / bank account
      const order = stateManager.get(orderNo);

      // Phase 2 only — Phase 1 (format-only) has no real name to compare
      if (result.name && config.surepass.nameMatchMode !== 'off') {
        // Refetch order detail if prefetch failed earlier
        if (!order.sellerName && !order.paymentDetails) {
          await this._prefetchOrderDetail(orderNo);
        }
        const refreshed = stateManager.get(orderNo);
        const kycName  = (refreshed.sellerName || '').trim();
        const bankName = refreshed.paymentDetails?.accountName?.trim() || '';

        let compareWith = '';
        let compareSource = '';
        if (kycName && kycName !== refreshed.sellerNickname) {
          compareWith = kycName; compareSource = 'binance_kyc';
        } else if (bankName) {
          compareWith = bankName; compareSource = 'bank_account_holder';
        }

        if (!compareWith) {
          logger.warn('Name match SKIPPED — no KYC or bank name available', {
            orderNo, panName: result.name,
          });
        } else {
          const m = matchNames(result.name, compareWith, config.surepass.nameMatchMode);
          logger.info('Name match check', {
            orderNo,
            panName:        result.name,
            compareName:    compareWith,
            compareSource,
            matched:        m.matched,
            kind:           m.kind,
            reason:         m.reason || null,
          });

          if (!m.matched) {
            const behavior = config.surepass.nameMismatchBehavior;
            if (behavior === 'block') {
              await this._send(orderNo, MESSAGES.NAME_MISMATCH());
              await this._escalate(orderNo,
                `Name mismatch: PAN="${result.name}" vs ${compareSource}="${compareWith}"`
              );
              return;
            }
            logger.warn('Name mismatch — proceeding (warn mode)', { orderNo });
          }
        }
      }

      // Calculate TDS, ask consent
      const tds = calculateTDS(order.amount, config.bot.tdsPercent);

      stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
        pan, tds, panName: result.name || null,
      });

      await this._send(orderNo, MESSAGES.PAN_VERIFIED_TDS(pan, tds));
      await sleep(1500);
      await this._send(orderNo, MESSAGES.TDS_INFO(tds));
      await sleep(1500);
      await this._send(orderNo, MESSAGES.TDS_CONSENT(tds));

      stateManager.set(orderNo, ORDER_STATE.WAITING_TDS_CONSENT);

    } catch (err) {
      // Only thrown for true server failures (5xx, network) — Surepass-side
      // "invalid PAN" already returned valid:false above. Inform seller in
      // a human-readable way and keep state in WAITING_FOR_PAN so they can
      // retry once the verification system recovers.
      logger.error('PAN verification system error', { orderNo, error: err.message });
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
      await this._send(orderNo, MESSAGES.PAN_API_DOWN());
    }
  }

  // ── Handle TDS consent ────────────────────────────────────────────────────
  async _handleTDSConsent(orderNo, text) {
    if (!isAgreementMessage(text)) {
      await this._send(orderNo,
        `Please reply *I AGREE* to confirm TDS deduction and proceed.\n\n` +
        `💳 🔥 I AGREE 🔥 💳`
      );
      return;
    }

    stateManager.set(orderNo, ORDER_STATE.TDS_ACCEPTED);
    await this._send(orderNo, MESSAGES.CONSENT_RECEIVED());
    await sleep(1000);
    await this._processPaymentFlow(orderNo);
  }

  // ── Payment flow — Req #3, #4 ─────────────────────────────────────────────
  async _processPaymentFlow(orderNo) {
    const order = stateManager.get(orderNo);

    try {
      stateManager.set(orderNo, ORDER_STATE.PROCESSING_PAYMENT);

      // Req #3: fetch seller payment details from order detail
      const orderDetail = await getOrderDetail(orderNo);
      const payDetails  = extractPaymentDetails(orderDetail);

      logger.info('Seller payment details fetched', {
        orderNo,
        method: payDetails.methodName,
        isUPI:  payDetails.isUPI,
      });

      stateManager.set(orderNo, ORDER_STATE.PROCESSING_PAYMENT, {
        paymentDetails: payDetails,
        payMethod:      payDetails.methodName,
      });

      // Req #4: auto-pay via Razorpay (or manual alert in Phase 1)
      const result = await processPayment(payDetails, order.tds.postTDS, orderNo);

      // Phase 1 — manual fallback
      if (result.manual) {
        stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_RELEASE);
        await this._send(orderNo, MESSAGES.MANUAL_PAYMENT_PENDING(order.tds, payDetails.methodName));
        logger.warn('Manual payment required', {
          orderNo,
          amount:      order.tds.postTDS,
          method:      payDetails.methodName,
          upi:         payDetails.upiId,
          accountNo:   payDetails.accountNo,
          ifsc:        payDetails.ifscCode,
          accountName: payDetails.accountName,
        });
        return;
      }

      // Phase 3 — auto payment succeeded
      stateManager.set(orderNo, ORDER_STATE.PAYMENT_SENT, {
        payoutId: result.payoutId,
        utr:      result.utr,
      });

      // Mark order as paid on Binance — bot is buyer (Req #5: seller releases later)
      try {
        await markOrderAsPaid(orderNo, payDetails.payId);
      } catch (err) {
        logger.error('markOrderAsPaid failed (payout already sent)', {
          orderNo, error: err.message,
        });
        logger.error('Payout sent but markOrderAsPaid FAILED — manual mark required', { orderNo });
      }

      await this._send(orderNo,
        MESSAGES.PAYMENT_SENT(
          order.tds,
          result.mode,
          result.utr,
          config.bot.tan
        )
      );

      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_RELEASE);

      logger.info('Payment sent', {
        orderNo,
        amount: order.tds.postTDS,
        mode:   result.mode,
        utr:    result.utr,
      });

    } catch (err) {
      logger.error('Payment flow error', { orderNo, error: err.message });
      stateManager.set(orderNo, ORDER_STATE.FAILED);
      await this._send(orderNo, MESSAGES.PAYMENT_FAILED());
    }
  }

  // ── Order status change handler — Req #6 ──────────────────────────────────
  //    Called by WSS push or by orderPoller's completion poll.
  async _onOrderStatusChange(orderNo, status) {
    const order = stateManager.get(orderNo);
    if (!order) return;
    if (order.state === ORDER_STATE.COMPLETED) return;

    const code = Number(status);

    if (code === ORDER_STATUS.COMPLETED) {
      await this.complete(orderNo);
      return;
    }

    if (code === ORDER_STATUS.CANCELLED || code === ORDER_STATUS.SYS_CANCELLED) {
      logger.warn('Order cancelled remotely', { orderNo, code });
      stateManager.set(orderNo, ORDER_STATE.CANCELLED);
      this._clearCancelTimer(orderNo);
      // Send a polite goodbye before disconnecting (chat may still be live)
      await this._send(orderNo, MESSAGES.ORDER_CANCELLED_REMOTE());
      chatService.disconnect(orderNo);
      return;
    }

    if (code === ORDER_STATUS.APPEALING) {
      await this._escalate(orderNo, `Order in appeal (status ${code})`);
      return;
    }
  }

  // ── PAN timeout timer ─────────────────────────────────────────────────────
  _startPANTimer(orderNo) {
    const reminderMs    = config.bot.panReminderMs;
    const lastWarningMs = Math.max(reminderMs + 60_000, config.bot.panTimeoutMs - 120_000);
    const cancelMs      = config.bot.panTimeoutMs;

    setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN, { reminderSent: true });
      await this._send(orderNo, MESSAGES.PAN_REMINDER());
    }, reminderMs);

    setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN, { lastWarningSent: true });
      await this._send(orderNo, MESSAGES.PAN_LAST_WARNING());
    }, lastWarningMs);

    setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      // Real Binance cancel — _autoCancel handles message + state + disconnect
      await this._autoCancel(orderNo, 'PAN timeout');
    }, cancelMs);
  }

  // ── Escalate ──────────────────────────────────────────────────────────────
  async _escalate(orderNo, reason) {
    logger.warn('Order escalated', { orderNo, reason });
    stateManager.set(orderNo, ORDER_STATE.ESCALATED);
    await this._send(orderNo, MESSAGES.ESCALATED());
    this._clearCancelTimer(orderNo);
    chatService.disconnect(orderNo);
  }

  // ── Send chat message helper ──────────────────────────────────────────────
  async _send(orderNo, text) {
    try {
      await chatService.sendMessage(orderNo, text);
    } catch (err) {
      logger.error('Failed to send chat message', { orderNo, error: err.message });
    }
  }

  // ── Trade complete — Req #6: configurable thank-you ───────────────────────
  async complete(orderNo) {
    const order = stateManager.get(orderNo);
    if (!order) return;
    if (order.state === ORDER_STATE.COMPLETED) return;

    stateManager.set(orderNo, ORDER_STATE.COMPLETED);
    await this._send(orderNo, MESSAGES.THANK_YOU(order.asset, order.cryptoAmount, orderNo));
    this._clearCancelTimer(orderNo);
    chatService.disconnect(orderNo);

    logger.info('Order completed! 🎉', {
      orderNo,
      crypto: `${order.cryptoAmount} ${order.asset}`,
    });
  }
}

const orderHandler = new OrderHandler();
module.exports = { orderHandler };
