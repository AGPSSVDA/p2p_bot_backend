const { stateManager, ORDER_STATE } = require('./stateManager');
const { MESSAGES }                  = require('./messages');
const { chatService }               = require('../services/chatService');
const { verifyPAN }                 = require('../services/panService');
const { processPayment }            = require('../services/paymentService');
const orderDb                       = require('../services/orderDbService');
const {
  ORDER_STATUS,
  CANCEL_REASON,
  pickSellerCancelReason,
  getOrderDetail,
  getChatCredential,
  extractPaymentDetails,
  markOrderAsPaid,
  markMessagesRead,
  cancelOrder,
  canCancelOrder,
} = require('../services/binanceService');
const botStatusService = require('../services/botStatusService');
const cashfreeVerificationService = require('../services/cashfreeVerificationService');
const {
  extractPAN,
  isProblemMessage,
  isAgreementMessage,
  maskPAN,
  calculateTDS,
  matchNames,
  tokenIntersectionMatch,
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

    // Track the ad the order came from (for the Ads page aggregation)
    orderDb.upsertAdFromOrder(rawOrder);

    logger.info('New order — starting handler', { orderNo });

    await this._connectChat(orderNo);

    // Await prefetch so we have a reliable sellerUserId before deciding
    // whether to run the returning-seller shortcut. _prefetchOrderDetail
    // never throws — it logs failures and returns — so we can rely on it.
    await this._prefetchOrderDetail(orderNo);

    const order = stateManager.get(orderNo);

    // Returning-seller shortcut: if this Binance seller has a prior order
    // that the bot verified end-to-end, skip the welcome + PAN ask + consent.
    //
    // SAFETY: we never match on a single soft signal. Accepted proofs:
    //   - Binance counterPartUserId exact match, OR
    //   - Binance nickname + KYC name composite (survives method changes), OR
    //   - KYC name + (bank account OR UPI) composite
    // See findVerifiedSellerHistory() for the full safety rationale.
    const history = await orderDb.findVerifiedSellerHistory({
      sellerUserId:   order.sellerUserId,
      sellerNickname: order.sellerNickname,
      sellerName:     order.sellerName,
      accountNo:      order.paymentDetails?.accountNo || null,
      upiId:          order.paymentDetails?.upiId || null,
    });
    if (history) {
      logger.info('Returning seller detected — applying TDS shortcut', {
        orderNo,
        sellerUserId:    order.sellerUserId || '(none)',
        sellerNickname:  order.sellerNickname || '(none)',
        sellerName:      order.sellerName || '(none)',
        matchedOn:       history.matched_on,
        previousOrderNo: history.order_no,
        previousPan:     maskPAN(history.pan),
      });
      await this._handleReturningSeller(orderNo, history);
      return;
    }

    logger.info('No prior verified order — running first-time PAN flow', {
      orderNo,
      sellerUserId:   order.sellerUserId || '(none)',
      sellerNickname: order.sellerNickname || '(none)',
      sellerName:     order.sellerName || '(none)',
      hasAccount:     !!order.paymentDetails?.accountNo,
      hasUpi:         !!order.paymentDetails?.upiId,
    });

    // First-time / unverified seller — run the normal welcome + PAN-request flow
    await this._send(orderNo, MESSAGES.WELCOME(order.sellerNickname, order.amount, order.asset));
    await sleep(1500);
    await this._send(orderNo, MESSAGES.PAN_REQUEST());

    stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
    this._startPANTimer(orderNo);
  }

  // ── Returning-seller shortcut ─────────────────────────────────────────────
  //   Re-uses a previously-verified PAN. Sends the 3-block consolidated
  //   message (Overview / Approval / Summary), then runs the normal payment
  //   flow. No PAN ask, no consent prompt, no PAN-timeout timer.
  async _handleReturningSeller(orderNo, history) {
    const order = stateManager.get(orderNo);
    if (!order) return;

    const tds = calculateTDS(order.amount, config.bot.tdsPercent);

    // Mark as PAN-verified using the historical PAN / name. Persists to DB
    // via stateManager.set() so the Orders page shows the reused PAN too.
    stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
      pan:     history.pan,
      panName: history.pan_name,
      tds,
    });
    // Inherit the previous order's name-match status so the Orders detail
    // drawer reflects that this is a trusted PAN reused from a prior verify.
    orderDb.updateOrder(orderNo, {
      name_match_status:          'MATCH',
      name_match_compare_source:  'previous_order',
    });

    // Send the multi-block consolidated message (Overview / Approval / Summary).
    // Identity fields come from the verified_sellers ledger (history) for the
    // PRIOR order, with safe fallbacks. `previousOrderNo` is the seller's
    // last completed order (so the seller sees a familiar order # they
    // recognise from before).
    const kycName =
      (history.seller_name || '').trim() ||
      (history.pan_name    || '').trim() ||
      (order.sellerName    || '').trim() ||
      (order.sellerNickname|| '').trim();

    const tplVars = {
      previousOrderNo: history.order_no,
      pan:             history.pan,
      panName:         history.pan_name,
      kycName,
      sellerNickname:  history.seller_nickname || order.sellerNickname || null,
      tds,
    };

    logger.info('Returning-seller TDS template — substitution vars', {
      orderNo,
      previousOrderNo: tplVars.previousOrderNo || '(none)',
      kycName:         tplVars.kycName         || '(none)',
      pan:             tplVars.pan ? maskPAN(tplVars.pan) : '(none)',
      panName:         tplVars.panName         || '(none)',
      sellerNickname:  tplVars.sellerNickname  || '(none)',
    });

    const blocks = await MESSAGES.RETURNING_SELLER_TDS(tplVars);
    logger.info('Returning-seller TDS — block count from DB', {
      orderNo,
      blockCount: blocks.length,
      blockPreviews: blocks.map((b, i) => ({
        idx:    i + 1,
        empty:  !b,
        length: b ? b.length : 0,
        head:   b ? b.substring(0, 80) : '(empty)',
      })),
    });
    // Send each block sequentially. Each send is _sendReliable so a single
    // queued/dropped delivery is retried — important here because missing
    // block 2 ("Hi {kycName}" + previous order #) breaks the narrative.
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) {
        logger.warn('Returning-seller TDS — empty block in template, skipping', {
          orderNo, blockIndex: i + 1,
        });
        continue;
      }
      const ok = await this._sendReliable(orderNo, block);
      logger.info('Returning-seller TDS — block delivery result', {
        orderNo, blockIndex: i + 1, length: block.length, delivered: ok,
      });
      await sleep(1500);
    }

    // Auto-accept TDS consent (they already approved on the prior order)
    stateManager.set(orderNo, ORDER_STATE.TDS_ACCEPTED);
    await sleep(500);

    // Run the existing payment flow
    await this._processPaymentFlow(orderNo);
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
  // Buffer is read from bot_config (set via the frontend dashboard) every
  // time we schedule, so changing it in the UI takes effect immediately for
  // any new order. Falls back to the static .env value if the DB read fails.
  async _scheduleAutoCancel(orderNo) {
    let buffer;
    try {
      buffer = await botStatusService.getAutoCancelBufferMs();
    } catch (_) {
      buffer = config.bot.autoCancelBufferMs;
    }
    if (buffer == null || buffer < 0) return;   // disabled

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

    // Bot kill-switch — when the operator toggled bot OFF from the dashboard,
    // NO Binance API call should fire. The poller / state machine still run
    // and tracking persists, but auto-cancel and the goodbye chat are muted.
    try {
      const enabled = await botStatusService.isBotEnabled();
      if (!enabled) {
        logger.info('Auto-cancel skipped — bot is OFF', {
          orderNo, state: order.state, trigger: reason,
        });
        return;
      }
    } catch (_) { /* fail-open: keep current behaviour if DB hiccup */ }

    // ──────────────────────────────────────────────────────────────────────
    // STRICT NO-CANCEL ZONE (per business rule — no loophole)
    //
    // Auto-cancel must NEVER fire once we've sent the seller money. The two
    // critical states this protects:
    //
    //   • PAYMENT_SENT       — Cashfree paid + markOrderAsPaid called on
    //                           Binance. If we cancel here, we've paid the
    //                           seller but lose our claim on the crypto.
    //   • WAITING_FOR_RELEASE — same, just one state later.
    //
    // Also blocked:
    //   • PROCESSING_PAYMENT  — Cashfree call is in-flight (can take up to
    //                           ~75s polling). Cancelling now would race
    //                           with Cashfree's pending transfer and could
    //                           still result in seller getting paid AND the
    //                           order being cancelled.
    //   • COMPLETED           — already done; cancelling is destructive.
    //   • CANCELLED           — idempotent; nothing to do.
    //
    // States where auto-cancel SHOULD fire (per dashboard timing):
    //   NEW_ORDER, WAITING_FOR_PAN, VALIDATING_PAN, PAN_VERIFIED,
    //   WAITING_TDS_CONSENT, TDS_ACCEPTED, AWAITING_MANUAL_PAYMENT,
    //   ESCALATED, FAILED.
    //
    // Note: AWAITING_MANUAL_PAYMENT is intentionally NOT in the unsafe list.
    // In that state, the operator has been told to pay but hasn't yet (no
    // markOrderAsPaid call), so cancelling is safe — no money has left.
    // ──────────────────────────────────────────────────────────────────────
    const unsafe = [
      ORDER_STATE.PROCESSING_PAYMENT,
      ORDER_STATE.PAYMENT_SENT,
      ORDER_STATE.WAITING_FOR_RELEASE,
      ORDER_STATE.COMPLETED,
      ORDER_STATE.CANCELLED,
    ];
    if (unsafe.includes(order.state)) {
      logger.warn('Auto-cancel skipped — past safe point (post-payment)', {
        orderNo, state: order.state, reason,
      });
      return;
    }

    // Belt-and-suspenders data guard. Even if the state somehow isn't in
    // the unsafe list above, the presence of a payout id or a real (non-
    // PEND-) UTR means Cashfree has paid and/or markOrderAsPaid has been
    // called for this order — never cancel in that case.
    const realUtr = order.utr && !String(order.utr).startsWith('PEND-');
    if (order.payoutId || realUtr) {
      logger.warn('Auto-cancel skipped — payout already initiated (data guard)', {
        orderNo, state: order.state, reason,
        payoutId: order.payoutId || null,
        utr:      order.utr || null,
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

    // Pick a random seller-fault reason from the curated pool. All codes in
    // the pool are "Due to seller" (3/4/6) so the bot's cancellation rate is
    // never debited. Rotating the displayed reason makes consecutive cancels
    // look less mechanical to the seller.
    const picked = pickSellerCancelReason();
    const reasonCode = picked.code;
    const additionalInfo = String(picked.info || '').slice(0, 200);

    logger.warn('Auto-cancelling order on Binance (Due to seller flow)', {
      orderNo, state: order.state, trigger: reason,
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
    this._clearPANTimers(orderNo);
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

    orderDb.logChatMessage({
      orderNo,
      direction: 'IN',
      sender: 'seller',
      text,
    });

    // Problem-keyword escalation ("cancel", "fraud", "scam", etc.) is
    // SKIPPED in nearly every state. Per business rule:
    //
    //   • WAITING_FOR_PAN / WAITING_TDS_CONSENT — the only advance trigger
    //     is a valid PAN or "I AGREE". Anything else, including "cancel",
    //     just keeps nudging with the retry template.
    //
    //   • PROCESSING_PAYMENT / AWAITING_MANUAL_PAYMENT / PAYMENT_SENT /
    //     WAITING_FOR_RELEASE — the payment is in flight or already settled
    //     on the bot side. Escalating here disconnects the chat, marks the
    //     order ESCALATED, and the completion poller no longer watches it
    //     — so the THANK_YOU never lands and the order stays ESCALATED
    //     even after the seller releases crypto. Never escalate post-pay.
    //
    //   • PAN_VERIFIED / TDS_ACCEPTED / VALIDATING_PAN — transient, the
    //     state machine is mid-step. WAIT_PROCESSING reply is enough.
    //
    // The only remaining states where the keyword check is meaningful are
    // NEW_ORDER (very early) and ESCALATED/FAILED (already terminal, the
    // _onMessage early-return skips terminal states anyway). So in practice
    // we only fire isProblemMessage in NEW_ORDER — and that's a rare race.
    const noEscalateStates = [
      ORDER_STATE.WAITING_FOR_PAN,
      ORDER_STATE.WAITING_TDS_CONSENT,
      ORDER_STATE.VALIDATING_PAN,
      ORDER_STATE.PAN_VERIFIED,
      ORDER_STATE.TDS_ACCEPTED,
      ORDER_STATE.PROCESSING_PAYMENT,
      ORDER_STATE.AWAITING_MANUAL_PAYMENT,
      ORDER_STATE.PAYMENT_SENT,
      ORDER_STATE.WAITING_FOR_RELEASE,
    ];
    if (!noEscalateStates.includes(order.state) && isProblemMessage(text)) {
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
      case ORDER_STATE.AWAITING_MANUAL_PAYMENT:
      case ORDER_STATE.VALIDATING_PAN:
        await this._send(orderNo, MESSAGES.WAIT_PROCESSING());
        break;

      case ORDER_STATE.PAYMENT_SENT:
      case ORDER_STATE.WAITING_FOR_RELEASE:
        // If Cashfree hasn't confirmed the bank settlement yet
        // (paymentPending flag set when we entered the pending branch of
        // _processPaymentFlow), the seller MUST see "payment is processing"
        // not "payment has already been sent" — the latter is misleading
        // and gets the seller angry (per real complaints: "i didn't receive
        // the money" / "noo it's not done" / "I'll report you" while the
        // bot keeps insisting payment is done).
        //
        // Once Cashfree's webhook calls finalizePayoutSuccess(), the flag
        // is cleared and subsequent seller messages get the standard
        // WAIT_RELEASE template with the real UTR already in chat history.
        if (order.paymentPending) {
          await this._send(orderNo,
            MESSAGES.PAYMENT_PROCESSING(
              order.tds,
              order.paymentMode || order.payMethod
            )
          );
        } else {
          await this._send(orderNo, MESSAGES.WAIT_RELEASE(order.payMethod));
        }
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
          this._clearPANTimers(orderNo);
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

      // PAN valid — verify the holder's identity using a two-step
      // token-intersection check. A token here is any name part (first /
      // middle / last). A step PASSES if ANY token of one side matches ANY
      // token of the other side (case-insensitive, punctuation/honorific
      // stripped). Both steps must pass to proceed.
      //
      //   Step 1: PAN name ↔ Binance KYC name
      //   Step 2: PAN name ↔ Bank account holder name
      //
      // If either step fails the order is escalated with the standard
      // NAME_MISMATCH template, listing which step(s) diverged.
      const order = stateManager.get(orderNo);

      if (result.name && config.surepass.nameMatchMode !== 'off') {
        // Refetch order detail if prefetch failed earlier
        if (!order.sellerName && !order.paymentDetails) {
          await this._prefetchOrderDetail(orderNo);
        }
        const refreshed = stateManager.get(orderNo);
        const kycName     = (refreshed.sellerName || '').trim();
        const panName     = (result.name || '').trim();

        // Resolve the BANK holder name authoritatively. Preferred source is
        // Cashfree's penny-drop verification — it returns the name on file
        // at the seller's bank, which is more reliable than the seller-
        // supplied account-holder name Binance ships in the order detail.
        // Fall back to the Binance-provided name if Cashfree fails (e.g.
        // Verifications product not enabled, IFSC malformed, network).
        const acc  = refreshed.paymentDetails?.accountNo;
        const ifsc = refreshed.paymentDetails?.ifscCode;
        const binanceProvidedName = refreshed.paymentDetails?.accountName?.trim() || '';

        let accountName       = binanceProvidedName;
        let accountNameSource = 'binance_order_detail';
        let cashfreeVerify    = null;

        // Operator-controlled toggle (Overview → Cashfree Bank Verify).
        // OFF (default) → use Binance-provided account holder name only.
        // ON            → call Cashfree penny-drop for the bank-side name,
        //                 fall back to Binance-provided on any failure.
        let pennyDropEnabled = false;
        try {
          pennyDropEnabled = await botStatusService.isCashfreeBankVerifyEnabled();
        } catch (_) { /* default OFF on DB hiccup */ }

        if (pennyDropEnabled && acc && ifsc) {
          cashfreeVerify = await cashfreeVerificationService.verifyBankAccount({
            accountNumber: acc,
            ifsc,
            name:          panName,
            orderNo,
          });
          if (cashfreeVerify.ok && cashfreeVerify.nameAtBank) {
            accountName       = cashfreeVerify.nameAtBank.trim();
            accountNameSource = 'cashfree_penny_drop';
            logger.info('Account holder name overridden by Cashfree penny-drop', {
              orderNo,
              cashfreeNameAtBank: cashfreeVerify.nameAtBank,
              binanceProvidedName,
              bankName:           cashfreeVerify.bankName || '(n/a)',
              accountStatus:      cashfreeVerify.accountStatus || '(n/a)',
              cashfreeMatchHint:  cashfreeVerify.nameMatchResult || '(n/a)',
            });
          } else {
            logger.warn('Cashfree penny-drop unavailable — falling back to Binance-provided account name', {
              orderNo,
              reason:              cashfreeVerify.reason || 'unknown',
              binanceProvidedName: binanceProvidedName || '(none)',
            });
          }
        } else if (!pennyDropEnabled) {
          logger.info('Cashfree penny-drop toggle is OFF — using Binance-provided account name', {
            orderNo,
            binanceProvidedName: binanceProvidedName || '(none)',
          });
        } else {
          logger.info('Skipping Cashfree penny-drop — no account+ifsc on order', {
            orderNo,
            hasAccount: !!acc,
            hasIfsc:    !!ifsc,
            hasUpi:     !!refreshed.paymentDetails?.upiId,
          });
        }

        // Don't compare against the seller's nickname (it's a screen name)
        const kycUsable = kycName && kycName !== refreshed.sellerNickname;

        // Step 1: PAN ↔ KYC
        let kycCheck = null;
        if (kycUsable) {
          kycCheck = tokenIntersectionMatch(panName, kycName);
          logger.info('Name match Step 1 — PAN ↔ Binance KYC', {
            orderNo,
            panName,
            kycName,
            matched: kycCheck.matched,
            overlap: kycCheck.overlap,
            reason:  kycCheck.reason,
          });
        }

        // Step 2: PAN ↔ Bank account holder
        // Source: Cashfree penny-drop when available, else Binance order detail.
        let bankCheck = null;
        if (accountName) {
          bankCheck = tokenIntersectionMatch(panName, accountName);
          logger.info('Name match Step 2 — PAN ↔ Bank Holder', {
            orderNo,
            panName,
            accountName,
            source:  accountNameSource,
            matched: bankCheck.matched,
            overlap: bankCheck.overlap,
            reason:  bankCheck.reason,
          });
        }

        if (!kycCheck && !bankCheck) {
          logger.warn('Name match SKIPPED — no KYC or bank name available', {
            orderNo, panName,
          });
        } else {
          const failed = [];
          const passed = [];
          if (kycCheck) {
            (kycCheck.matched ? passed : failed).push({
              source: 'Binance KYC', label: 'binance_kyc',
              compareName: kycName, reason: kycCheck.reason,
            });
          }
          if (bankCheck) {
            (bankCheck.matched ? passed : failed).push({
              source: 'Bank Holder', label: 'bank_account_holder',
              compareName: accountName, reason: bankCheck.reason,
            });
          }

          if (failed.length > 0) {
            const behavior = config.surepass.nameMismatchBehavior;
            const mismatchedSources = failed.map((c) => c.source).join(', ');

            // Persist mismatch on the order row for the frontend
            orderDb.updateOrder(orderNo, {
              name_match_status:          'MISMATCH',
              name_match_compare_source:  failed.map((c) => c.label).join(','),
            });

            if (behavior === 'block') {
              // Send the mismatch message and ASK FOR A NEW PAN. The bot
              // stays responsive — it doesn't escalate unless the seller
              // burns through maxPanRetries first. Same retry mechanic the
              // PAN-format / Surepass-invalid branches above use.
              await this._send(orderNo, MESSAGES.NAME_MISMATCH({
                panName,
                kycName:     kycUsable ? kycName : '—',
                accountName: accountName || '—',
                mismatchedSources,
              }));

              const retries = stateManager.incPanRetry(orderNo);
              if (retries >= config.bot.maxPanRetries) {
                this._clearPANTimers(orderNo);
                await this._send(orderNo, MESSAGES.PAN_MAX_RETRIES());
                await this._escalate(orderNo,
                  `Name mismatch + max retries (${retries}): PAN="${panName}" vs [${failed.map((c) => `${c.label}="${c.compareName}" (${c.reason})`).join(', ')}]`
                );
              } else {
                // Reset to WAITING_FOR_PAN so the next incoming message
                // routes back into _handlePANReply.
                stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
                logger.info('Name mismatch — asking seller for correct PAN', {
                  orderNo,
                  retries,
                  maxRetries: config.bot.maxPanRetries,
                  mismatchedSources,
                });
              }
              return;
            }
            logger.warn('Name mismatch — proceeding (warn mode)', {
              orderNo, mismatchedSources,
            });
            // Soft-failed verification: name_match_status stays 'MISMATCH'
            // in the orders row, which blocks the post-completion promotion
            // to verified_sellers automatically (gate is on MATCH only).
          } else {
            // All available steps passed — store positive status
            orderDb.updateOrder(orderNo, {
              name_match_status:          'MATCH',
              name_match_compare_source:  passed.map((c) => c.label).join(','),
            });
          }
        }
      }

      // Calculate TDS, ask consent.
      // NOTE: we no longer promote the seller to verified_sellers HERE.
      // Promotion is deferred to orderHandler.complete() so it only fires
      // once the order has actually settled (state = COMPLETED). That way
      // a PAN captured for an order that ends up cancelled / escalated /
      // stuck mid-flow never becomes a future shortcut trigger.
      const tds = calculateTDS(order.amount, config.bot.tdsPercent);

      // PAN accepted — kill the reminder / last-warning / PAN-cancel timers
      // BEFORE any further async work. Otherwise a slow payment flow can
      // still race against a pending warning timer.
      this._clearPANTimers(orderNo);

      stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
        pan, tds, panName: result.name || null,
      });

      await this._send(orderNo, MESSAGES.PAN_VERIFIED_TDS(pan, tds, result.name));
      await sleep(1500);

      // tdsInfo is multi-block: send each variation the admin added in
      // the Chat Templates page (every block gets {tds}/{quarter}/etc.
      // substituted from the same vars map). Use _sendReliable so a
      // transient WSS hiccup doesn't drop a block mid-sequence.
      const tdsInfoBlocks = await MESSAGES.TDS_INFO(tds);
      for (let i = 0; i < tdsInfoBlocks.length; i++) {
        const block = tdsInfoBlocks[i];
        if (!block) continue;
        await this._sendReliable(orderNo, block);
        await sleep(1200);
      }

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
      await this._send(orderNo, MESSAGES.TDS_CONSENT_RETRY());
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

      // Manual fallback. Park the order in AWAITING_MANUAL_PAYMENT and
      // tell the seller. The Payments page flips it to PAYMENT_SENT when
      // the operator approves. AWAITING_MANUAL_PAYMENT is in the auto-
      // cancel "unsafe" list so the timer won't cancel the order during
      // the operator's pay-out window.
      if (result.manual) {
        stateManager.set(orderNo, ORDER_STATE.AWAITING_MANUAL_PAYMENT);
        orderDb.recordPayoutPending(stateManager.get(orderNo));

        // Pick the right message based on WHY auto-payment was skipped:
        //   above_limit  → amount exceeds the auto-pay cap
        //   upi_only     → seller gave UPI only (Cashfree wallet can't pay UPI)
        //   else         → generic "payment is being prepared"
        if (result.reason === 'above_limit') {
          await this._send(orderNo, MESSAGES.MANUAL_PAYMENT_ABOVE_LIMIT({
            amount: order.tds.postTDS,
            limit:  result.cap || config.bot.maxPaymentAmount,
            method: payDetails.methodName,
          }));
        } else if (result.reason === 'upi_only') {
          await this._send(orderNo, MESSAGES.MANUAL_PAYMENT_UPI({
            upi:     payDetails.upiId,
            postTDS: order.tds.postTDS,
          }));
        } else {
          await this._send(orderNo, MESSAGES.MANUAL_PAYMENT_PENDING(order.tds, payDetails.methodName));
        }

        logger.warn('Manual payment required', {
          orderNo,
          reason:      result.reason || 'unspecified',
          amount:      order.tds.postTDS,
          method:      payDetails.methodName,
          upi:         payDetails.upiId,
          accountNo:   payDetails.accountNo,
          ifsc:        payDetails.ifscCode,
          accountName: payDetails.accountName,
        });
        return;
      }

      // ── PENDING branch ─────────────────────────────────────────────────
      // Cashfree accepted the transfer but the bank hasn't confirmed yet.
      // Per business rule:
      //   1. markOrderAsPaid on Binance now (so Binance doesn't auto-cancel)
      //   2. Send the PAYMENT_PROCESSING template (NOT PAYMENT_SENT with a
      //      junk PEND- UTR like before)
      //   3. Park the order in WAITING_FOR_RELEASE with paymentPending: true
      //      + a PEND-<transferId> placeholder UTR (used by the webhook to
      //      look up the order)
      //   4. Cashfree's webhook (cashfreeWebhookController) will later call
      //      finalizePayoutSuccess() or finalizePayoutFailed() depending on
      //      the bank's final response — that's where the real UTR /
      //      cancel-on-failure logic lives.
      if (result.pending) {
        const placeholderUtr = `PEND-${result.transferId || result.payoutId}`;

        stateManager.set(orderNo, ORDER_STATE.PAYMENT_SENT, {
          payoutId:        result.payoutId,
          utr:             placeholderUtr,
          paymentPending:  true,
          paymentMode:     result.mode,
        });
        this._clearCancelTimer(orderNo);
        orderDb.recordPayoutPending(stateManager.get(orderNo));

        // Mark paid on Binance immediately so the buyer's-side auto-cancel
        // doesn't fire while we wait for Cashfree to settle. We pass the
        // PEND- placeholder as payInfo; Binance just shows whatever string
        // we send as payment proof.
        try {
          await markOrderAsPaid(orderNo, payDetails.payId, placeholderUtr);
        } catch (err) {
          logger.error('markOrderAsPaid failed during pending payout', {
            orderNo, error: err.message,
          });
        }

        await this._send(orderNo,
          MESSAGES.PAYMENT_PROCESSING(order.tds, result.mode)
        );

        stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_RELEASE, {
          paymentPending: true,
        });

        logger.info('Payment PENDING — awaiting Cashfree webhook', {
          orderNo,
          transferId: result.transferId || result.payoutId,
          mode:       result.mode,
          amount:     order.tds.postTDS,
        });
        return;
      }

      // Auto-payment succeeded immediately. Mark state, persist payout,
      // then ensure the auto-cancel timer never fires for this order again
      // (belt and suspenders — the unsafe-state guard already blocks it,
      // but freeing the timer is cleaner).
      stateManager.set(orderNo, ORDER_STATE.PAYMENT_SENT, {
        payoutId: result.payoutId,
        utr:      result.utr,
        paymentPending: false,
      });
      this._clearCancelTimer(orderNo);
      orderDb.recordPayoutSuccess(
        stateManager.get(orderNo),
        result.payoutId,
        result.utr,
        result.mode
      );

      // Mark order as paid on Binance immediately — triggers Binance's own
      // "buyer has marked the order as paid" system message in the chat
      // (the red-circled one in the seller's screenshot). UTR is passed via
      // payInfo so it shows on Binance's seller-side UI as the payment proof.
      // Bot is buyer; seller releases crypto next.
      try {
        await markOrderAsPaid(orderNo, payDetails.payId, result.utr);
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

      // Cashfree returned a HARD failure (FAILED / REJECTED / REVERSED) on
      // the initial poll → cancel the order on Binance per business rule.
      // Safe here because we never called markOrderAsPaid in this branch.
      try {
        const allowed = await canCancelOrder(orderNo);
        if (allowed) {
          const picked = pickSellerCancelReason();
          await cancelOrder(orderNo, picked.code, String(picked.info || '').slice(0, 200));
          stateManager.set(orderNo, ORDER_STATE.CANCELLED);
          logger.warn('Order cancelled on Binance after Cashfree hard fail', {
            orderNo, reason: err.message,
          });
        } else {
          logger.warn('Cashfree hard fail but Binance says cancel not allowed', {
            orderNo, reason: err.message,
          });
        }
      } catch (cancelErr) {
        logger.error('Cancel-on-Cashfree-fail attempt failed', {
          orderNo, error: cancelErr.message,
        });
      }
    }
  }

  // ── Finalize a PENDING payout when Cashfree's webhook confirms SUCCESS ──
  //   Called by cashfreeWebhookController. Idempotent — skips if we've
  //   already finalized (utr no longer starts with PEND-) or if the order
  //   is already in a terminal state.
  //
  //   Steps:
  //     1. Update orders/payouts rows with the real UTR
  //     2. Send the full PAYMENT_SENT template with the real UTR
  //     3. Leave state as WAITING_FOR_RELEASE — seller still needs to
  //        release crypto. COMPLETED transition is driven by Binance's
  //        order_status push as usual.
  async finalizePayoutSuccess(orderNo, realUtr, mode) {
    const order = stateManager.get(orderNo);
    if (!order) {
      logger.warn('finalizePayoutSuccess: order not in stateManager (already gone?)', {
        orderNo, realUtr,
      });
      return;
    }
    // Idempotency: already finalized?
    if (order.utr && !String(order.utr).startsWith('PEND-')) {
      logger.info('finalizePayoutSuccess: already finalized — skipping', {
        orderNo, existingUtr: order.utr,
      });
      return;
    }
    // Skip if state has already moved to a terminal we don't want to disturb
    const terminal = [
      ORDER_STATE.COMPLETED, ORDER_STATE.CANCELLED,
      ORDER_STATE.FAILED,    ORDER_STATE.ESCALATED,
    ];
    if (terminal.includes(order.state)) {
      logger.info('finalizePayoutSuccess: order already terminal — only updating UTR', {
        orderNo, state: order.state, realUtr,
      });
      stateManager.set(orderNo, order.state, {
        utr: realUtr, paymentPending: false,
      });
      return;
    }

    stateManager.set(orderNo, order.state, {
      utr:            realUtr,
      paymentPending: false,
    });

    const effectiveMode = mode || order.paymentMode || 'IMPS';

    await this._sendReliable(orderNo,
      MESSAGES.PAYMENT_SENT(
        order.tds,
        effectiveMode,
        realUtr,
        config.bot.tan
      )
    );

    logger.info('Pending payout FINALIZED as SUCCESS', {
      orderNo,
      realUtr,
      mode: effectiveMode,
    });
  }

  // ── Finalize a PENDING payout when Cashfree's webhook reports FAILURE ───
  //   Called by cashfreeWebhookController. Per business rule:
  //     1. Send PAYMENT_FAILED template (so the seller knows what happened)
  //     2. Attempt to cancel the order on Binance — Binance may reject
  //        this if the seller already released crypto, in which case the
  //        cancel attempt is logged and the order is moved to FAILED.
  //
  //   Idempotent — skips if the order is already in FAILED/CANCELLED.
  async finalizePayoutFailed(orderNo, reason) {
    const order = stateManager.get(orderNo);
    if (!order) {
      logger.warn('finalizePayoutFailed: order not in stateManager', { orderNo });
      return;
    }
    if (order.state === ORDER_STATE.CANCELLED || order.state === ORDER_STATE.FAILED) {
      logger.info('finalizePayoutFailed: already terminal — skipping', {
        orderNo, state: order.state,
      });
      return;
    }

    logger.error('Pending payout FINALIZED as FAILED — cancelling Binance order', {
      orderNo, reason,
    });

    await this._sendReliable(orderNo, MESSAGES.PAYMENT_FAILED());

    try {
      const allowed = await canCancelOrder(orderNo);
      if (allowed) {
        const picked = pickSellerCancelReason();
        await cancelOrder(orderNo, picked.code,
          `Cashfree payout failed: ${String(reason || '').slice(0, 150)}`
        );
        stateManager.set(orderNo, ORDER_STATE.CANCELLED, {
          cancel_reason: `Cashfree payout failed: ${reason || 'n/a'}`,
        });
        logger.warn('Order cancelled on Binance after Cashfree pending → fail', {
          orderNo, reason,
        });
      } else {
        // Seller likely already released crypto — we can no longer cancel.
        // Mark FAILED locally so the operator sees this needs attention.
        stateManager.set(orderNo, ORDER_STATE.FAILED, {
          cancel_reason: `Cashfree payout failed but Binance refused cancel: ${reason || 'n/a'}`,
        });
        logger.error('Cashfree fail but Binance won\'t cancel — manual intervention required', {
          orderNo, reason,
        });
      }
    } catch (cancelErr) {
      logger.error('Cancel attempt after Cashfree fail threw', {
        orderNo, error: cancelErr.message, reason,
      });
      stateManager.set(orderNo, ORDER_STATE.FAILED, {
        cancel_reason: `Cashfree payout failed: ${reason || 'n/a'} (cancel attempt also threw: ${cancelErr.message})`,
      });
    }

    this._clearCancelTimer(orderNo);
    this._clearPANTimers(orderNo);
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
      this._clearPANTimers(orderNo);
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
  //   Reminder / last-warning / cancel timers — all delays come from
  //   bot_config (dashboard-tunable) at the moment this fires, with .env
  //   fallback if the DB read fails.
  //
  //   The handles are stored in this._panTimers[orderNo] so _clearPANTimers()
  //   can kill them the moment the seller's PAN is accepted. We don't rely on
  //   the in-callback state guard alone — once we leave WAITING_FOR_PAN the
  //   timers are CANCELLED, so an unrelated payment-fail (or any other later
  //   chat send) can never race into a "send your PAN now" warning.
  async _startPANTimer(orderNo) {
    let reminderMs, cancelMs;
    try {
      reminderMs = await botStatusService.getPanReminderMs();
      cancelMs   = await botStatusService.getPanTimeoutMs();
    } catch (_) {
      reminderMs = config.bot.panReminderMs;
      cancelMs   = config.bot.panTimeoutMs;
    }
    const lastWarningMs = Math.max(reminderMs + 60_000, cancelMs - 120_000);

    if (!this._panTimers) this._panTimers = {};
    this._clearPANTimers(orderNo);   // defensive

    const reminderTimer = setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN, { reminderSent: true });
      await this._send(orderNo, MESSAGES.PAN_REMINDER());
    }, reminderMs);

    const lastWarningTimer = setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN, { lastWarningSent: true });
      await this._send(orderNo, MESSAGES.PAN_LAST_WARNING());
    }, lastWarningMs);

    const cancelTimer = setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      // Real Binance cancel — _autoCancel handles message + state + disconnect
      await this._autoCancel(orderNo, 'PAN timeout');
    }, cancelMs);

    this._panTimers[orderNo] = [reminderTimer, lastWarningTimer, cancelTimer];
  }

  // ── Clear all PAN-stage timers for an order ──────────────────────────────
  //   Must be called the moment we leave WAITING_FOR_PAN for good (PAN
  //   verified, escalated, cancelled, completed). NOT called on a PAN-invalid
  //   retry — there we deliberately stay in WAITING_FOR_PAN and the timer
  //   should keep counting against the deadline the seller has already burned.
  _clearPANTimers(orderNo) {
    if (!this._panTimers || !this._panTimers[orderNo]) return;
    for (const t of this._panTimers[orderNo]) clearTimeout(t);
    delete this._panTimers[orderNo];
  }

  // ── Escalate ──────────────────────────────────────────────────────────────
  async _escalate(orderNo, reason) {
    logger.warn('Order escalated', { orderNo, reason });
    stateManager.set(orderNo, ORDER_STATE.ESCALATED);
    await this._send(orderNo, MESSAGES.ESCALATED());
    this._clearCancelTimer(orderNo);
    this._clearPANTimers(orderNo);
    chatService.disconnect(orderNo);
  }

  // ── Send chat message helper ──────────────────────────────────────────────
  //  Accepts a string OR Promise<string> so callers can pass MESSAGES.X()
  //  directly (they're DB-backed and async now).
  //
  //  Returns true ONLY when chatService confirms the message actually went
  //  out over the live WSS. A queued/dropped send returns false so the
  //  caller can decide to retry — important for the multi-block templates
  //  (returning-seller, tdsInfo, thankYou) where missing a block in the
  //  middle of the sequence breaks the conversation.
  async _send(orderNo, textOrPromise) {
    let text;
    try {
      text = textOrPromise && typeof textOrPromise.then === 'function'
        ? await textOrPromise
        : textOrPromise;
      if (!text) return false;
      const res = await chatService.sendMessage(orderNo, text);
      orderDb.logChatMessage({ orderNo, direction: 'OUT', sender: 'bot', text });
      if (res && res.ok) return true;
      logger.warn('Chat send did not confirm — message may be queued or dropped', {
        orderNo,
        via:     res?.via || 'unknown',
        preview: String(text).substring(0, 60),
      });
      return false;
    } catch (err) {
      logger.error('Failed to send chat message', {
        orderNo, error: err.message,
        preview: text ? String(text).substring(0, 60) : '(none)',
      });
      return false;
    }
  }

  // ── Robust send with retry — used for critical multi-block templates ─────
  //  Tries up to `attempts` times, with a `delayMs` pause between tries, so
  //  a transient WSS closure (e.g. just after the previous block) doesn't
  //  leave a hole in the middle of a template sequence.
  async _sendReliable(orderNo, textOrPromise, attempts = 3, delayMs = 1500) {
    const text = textOrPromise && typeof textOrPromise.then === 'function'
      ? await textOrPromise
      : textOrPromise;
    if (!text) return false;
    for (let i = 1; i <= attempts; i++) {
      const ok = await this._send(orderNo, text);
      if (ok) return true;
      if (i < attempts) {
        logger.warn('Retrying chat send', {
          orderNo, attempt: i, attempts,
          preview: String(text).substring(0, 60),
        });
        await sleep(delayMs);
      }
    }
    logger.error('Chat send failed after all retries', {
      orderNo, attempts,
      preview: String(text).substring(0, 60),
    });
    return false;
  }

  // ── Trade complete — Req #6: configurable thank-you ───────────────────────
  async complete(orderNo) {
    const order = stateManager.get(orderNo);
    if (!order) return;
    if (order.state === ORDER_STATE.COMPLETED) return;

    stateManager.set(orderNo, ORDER_STATE.COMPLETED);

    // Send all thank-you blocks the admin configured (up to 5 variations
    // in the Chat Templates page). Old behaviour was just texts[0]; now
    // every step_order entry fires sequentially with a small delay so they
    // arrive as separate chat messages instead of one merged one.
    const blocks = await MESSAGES.THANK_YOU(order.asset, order.cryptoAmount, orderNo);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      await this._sendReliable(orderNo, block);
      await sleep(1200);
    }

    this._clearCancelTimer(orderNo);
    this._clearPANTimers(orderNo);
    chatService.disconnect(orderNo);

    logger.info('Order completed! 🎉', {
      orderNo,
      crypto: `${order.cryptoAmount} ${order.asset}`,
    });

    // Now that the order has actually settled, promote this seller into
    // the verified_sellers ledger so future orders from the same identity
    // can take the returning-seller TDS shortcut. Gated internally on:
    //   state = COMPLETED, pan IS NOT NULL, processed_by = 'BOT',
    //   name_match_status = 'MATCH'.
    // Fire-and-forget — DB hiccup must not break the live flow.
    orderDb.promoteToVerifiedIfEligible(orderNo);
  }
}

const orderHandler = new OrderHandler();
module.exports = { orderHandler };
