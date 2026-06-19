const { stateManager, ORDER_STATE } = require('./stateManager');
const { chatService }               = require('../services/chatService');
const messageService                = require('../services/messageService');
const { verifyPAN }                 = require('../services/panService');
const { processPayment }            = require('../services/payments');
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
const bankVerificationService = require('../services/surepassBankVerificationService');
const {
  extractPAN,
  isProblemMessage,
  isAgreementMessage,
  maskPAN,
  calculateTDS,
  matchNames,
  tokenIntersectionMatch,
  parseBankAccountInput,
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

    // First-time / unverified seller — run the normal welcome + PAN-request
    // flow. Both sections support multiple message blocks (add more in the
    // Chat Templates page and they all send, in order).
    await this._sendTpl(orderNo, 'welcome');
    await sleep(1500);
    await this._sendTpl(orderNo, 'panRequest');

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

    // Identity fields come from the verified_sellers ledger (history) for the
    // PRIOR order, with safe fallbacks. previousOrderNo is the seller's last
    // completed order (so they see a familiar order # they recognise).
    const kycName =
      (history.seller_name || '').trim() ||
      (history.pan_name    || '').trim() ||
      (order.sellerName    || '').trim() ||
      (order.sellerNickname|| '').trim();

    // Mark as PAN-verified using the historical PAN / name AND store
    // previousOrderNo on the state so _buildVars exposes {previousOrderNo}
    // (and {pan}/{panName}) to EVERY template for this order.
    stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
      pan:             history.pan,
      panName:         history.pan_name,
      previousOrderNo: history.order_no,
      tds,
    });

    // ── Bank-info change check (Option B) ──────────────────────────────
    // Returning sellers normally skip ALL re-verification. But if their
    // bank account info on THIS order differs from what was verified on
    // the prior order, we must re-run Surepass bank-verification on the
    // new account — otherwise a compromised Binance ad could redirect
    // payment to an attacker's account. Only fires when:
    //   • Bank Verify toggle is ON (Surepass)
    //   • Current order has bank info (not UPI-only)
    //   • account_no or IFSC differs from the verified_sellers ledger
    const currentAccountNo = String(order.paymentDetails?.accountNo || '').trim();
    const currentIfsc      = String(order.paymentDetails?.ifscCode  || '').trim().toUpperCase();
    const historyAccountNo = String(history.account_no || '').trim();
    const historyIfsc      = String(history.ifsc_code  || '').trim().toUpperCase();
    const hasCurrentBank   = !!(currentAccountNo && currentIfsc);
    const bankInfoChanged  = currentAccountNo !== historyAccountNo
                          || currentIfsc      !== historyIfsc;

    let bankVerifyEnabled = false;
    try {
      bankVerifyEnabled = await botStatusService.isBankVerifyEnabled();
    } catch (_) { /* default OFF on DB hiccup */ }

    if (bankVerifyEnabled && hasCurrentBank && bankInfoChanged) {
      logger.info('Returning seller — bank info CHANGED from prior order, re-verifying via Surepass', {
        orderNo,
        previousAccount: historyAccountNo
          ? `${historyAccountNo.slice(0, 4)}…${historyAccountNo.slice(-4)}` : '(none)',
        previousIfsc:    historyIfsc || '(none)',
        newAccount:      `${currentAccountNo.slice(0, 4)}…${currentAccountNo.slice(-4)}`,
        newIfsc:         currentIfsc,
      });

      let bankVerify = null;
      try {
        bankVerify = await bankVerificationService.verifyBankAccount({
          accountNumber: currentAccountNo,
          ifsc:          currentIfsc,
          orderNo,
        });
      } catch (err) {
        logger.error('Returning-seller Surepass call threw — proceeding without re-verify (Surepass down)', {
          orderNo, error: err.message,
        });
      }

      if (bankVerify && bankVerify.ok && bankVerify.nameAtBank) {
        const newAccountName = bankVerify.nameAtBank.trim();
        const bankCheck      = tokenIntersectionMatch(kycName, newAccountName);

        logger.info('Returning seller — bank-name match attempt (new account)', {
          orderNo,
          kycName,
          newAccountName,
          matched: bankCheck.matched,
          overlap: bankCheck.overlap,
          reason:  bankCheck.reason,
        });

        if (!bankCheck.matched) {
          // Mismatch on new account — route into the bank-retry flow,
          // EXACTLY like first-time sellers. _handleBankAccountReply will
          // call _proceedToTdsConsent on success, which routes back into
          // the returning-seller TDS template because previousOrderNo is
          // already set on the state.
          logger.warn('Returning seller — new bank holder name mismatch, starting bank-retry flow', {
            orderNo, kycName, newAccountName,
          });
          orderDb.updateOrder(orderNo, {
            name_match_status:         'MISMATCH',
            name_match_compare_source: 'returning_seller_bank_reverify',
          });
          await this._sendTpl(orderNo, 'nameMismatch', {
            panName:           history.pan_name || '—',
            kycName:           kycName || '—',
            accountName:       newAccountName,
            mismatchedSources: 'Bank Holder',
          });
          await sleep(1000);
          await this._sendTpl(orderNo, 'bankAccountRequest');
          stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_BANK_ACCOUNT, {
            bankRetries: 0,
          });
          return;
        }

        // Match — overwrite paymentDetails with Surepass's authoritative
        // bank-side name + bank metadata so subsequent templates and the
        // payment routing use this verified info. Lock the details with
        // paymentDetailsOverridden so _processPaymentFlow doesn't re-fetch
        // from Binance and clobber the verified account info.
        const existingDetails = order.paymentDetails || {};
        const updatedDetails  = {
          ...existingDetails,
          accountName: newAccountName,
          bankName:    bankVerify.bankName || existingDetails.bankName || null,
        };
        stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
          paymentDetails:           updatedDetails,
          paymentDetailsOverridden: true,
        });
        logger.info('Returning seller — new bank verified, proceeding to payment flow', {
          orderNo, accountName: newAccountName,
        });
      } else {
        // Surepass returned no usable result OR API was unreachable.
        // We've already done the PAN trust check via verified_sellers —
        // don't block the seller on Surepass infra issues. Log loudly so
        // the operator can audit.
        logger.warn('Returning seller — Surepass re-verify failed, proceeding without bank-name check', {
          orderNo, reason: bankVerify?.reason || 'unknown',
        });
      }
    } else if (bankVerifyEnabled && hasCurrentBank && !bankInfoChanged) {
      logger.info('Returning seller — bank info unchanged from prior order, skipping re-verify (fast path)', {
        orderNo,
        accountNo: `${currentAccountNo.slice(0, 4)}…${currentAccountNo.slice(-4)}`,
        ifsc:      currentIfsc,
      });
    }

    // Inherit the previous order's name-match status so the Orders detail
    // drawer reflects that this is a trusted PAN reused from a prior verify.
    orderDb.updateOrder(orderNo, {
      name_match_status:          'MATCH',
      name_match_compare_source:  bankInfoChanged
        ? 'returning_seller_bank_reverified'
        : 'previous_order',
    });

    logger.info('Returning-seller TDS — sending consolidated blocks', {
      orderNo,
      previousOrderNo: history.order_no || '(none)',
      kycName:         kycName || '(none)',
      pan:             history.pan ? maskPAN(history.pan) : '(none)',
    });

    // Multi-block consolidated message (Overview / Approval / Summary, plus
    // any extra blocks the admin added). previousOrderNo is on the state now,
    // so passing it as an extra is belt-and-suspenders. kycName is overridden
    // here because the history-derived name is preferred over the live state.
    await this._sendTplReliable(orderNo, 'returningSellerTdsApplied', {
      previousOrderNo: history.order_no || '—',
      kycName:         kycName || 'Customer',
      sellerNickname:  history.seller_nickname || order.sellerNickname || '—',
    });

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
    // 0 (or null / negative) = auto-cancel disabled. Don't even schedule a
    // timer. This is the user-facing master switch on the Bot Timers card.
    if (buffer == null || buffer <= 0) {
      logger.info('Auto-cancel disabled (auto_cancel_buffer_ms ≤ 0) — no timer scheduled', {
        orderNo,
      });
      return;
    }

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

    // Master switch: auto_cancel_buffer_ms = 0 disables ALL bot-initiated
    // auto-cancel, no matter how the cancel was triggered (pre-deadline
    // timer, PAN timeout, etc.). This is the UI's "0 = disabled" semantics.
    try {
      const buffer = await botStatusService.getAutoCancelBufferMs();
      if (buffer != null && buffer <= 0) {
        logger.info('Auto-cancel suppressed — auto_cancel_buffer_ms = 0', {
          orderNo, state: order.state, trigger: reason,
        });
        return;
      }
    } catch (_) { /* fail-open: if DB read fails, proceed with cancel */ }

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
    // Auto-cancel must NEVER fire if ANY of these hold:
    //
    //   1. Order is in (or past) a payment-related state:
    //        • PROCESSING_PAYMENT   — provider call in-flight (race risk)
    //        • PAYMENT_SENT         — provider paid + markPaid called
    //        • WAITING_FOR_RELEASE  — same, awaiting seller release
    //        • AWAITING_MANUAL_PAYMENT — operator pays manually; bot must
    //                                    never cancel a manual-payment order
    //                                    (per business rule). Operator's
    //                                    window is unlimited from the bot's
    //                                    side — Binance's own deadline still
    //                                    applies on their side, but the bot
    //                                    does not contribute to it.
    //        • COMPLETED            — already done
    //        • CANCELLED            — idempotent no-op
    //
    //   2. markOrderAsPaid was already called on Binance (paidOnBinance flag).
    //      Once we've told Binance "we paid", cancelling from our side would
    //      strand the seller's funds AND lose our claim on the crypto.
    //      ONLY a confirmed PAYMENT-PROVIDER FAILURE (finalizePayoutFailed)
    //      may cancel a paid order, and that path goes through a separate
    //      cancel-after-fail flow — never through _autoCancel.
    //
    //   3. A payout was initiated (payoutId present) or a REAL UTR exists.
    //      Belt-and-suspenders data guard for any state-tracking glitch.
    //
    // States where auto-cancel SHOULD fire (PRE-payment only):
    //   NEW_ORDER, WAITING_FOR_PAN, VALIDATING_PAN, PAN_VERIFIED,
    //   WAITING_TDS_CONSENT, TDS_ACCEPTED, ESCALATED, FAILED.
    // ──────────────────────────────────────────────────────────────────────
    const unsafe = [
      ORDER_STATE.PROCESSING_PAYMENT,
      ORDER_STATE.PAYMENT_SENT,
      ORDER_STATE.WAITING_FOR_RELEASE,
      ORDER_STATE.AWAITING_MANUAL_PAYMENT,
      ORDER_STATE.COMPLETED,
      ORDER_STATE.CANCELLED,
    ];
    if (unsafe.includes(order.state)) {
      logger.warn('Auto-cancel skipped — past safe point (post-payment / manual)', {
        orderNo, state: order.state, reason,
      });
      return;
    }

    // Belt-and-suspenders data guards. Any of these means we've already
    // committed to paying (or marked paid on Binance) — never cancel.
    const realUtr = order.utr && !String(order.utr).startsWith('PEND-');
    if (order.payoutId || realUtr || order.paidOnBinance) {
      logger.warn('Auto-cancel skipped — payment already committed (data guard)', {
        orderNo, state: order.state, reason,
        payoutId:       order.payoutId      || null,
        utr:            order.utr           || null,
        paidOnBinance:  order.paidOnBinance || false,
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
      await this._sendTpl(orderNo, 'orderCancelled');
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
        await this._sendTpl(orderNo, 'panImageRejected');
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
      ORDER_STATE.WAITING_FOR_BANK_ACCOUNT,
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

      case ORDER_STATE.WAITING_FOR_BANK_ACCOUNT:
        await this._handleBankAccountReply(orderNo, text);
        break;

      case ORDER_STATE.WAITING_TDS_CONSENT:
        await this._handleTDSConsent(orderNo, text);
        break;

      case ORDER_STATE.PAN_VERIFIED:
      case ORDER_STATE.TDS_ACCEPTED:
      case ORDER_STATE.PROCESSING_PAYMENT:
      case ORDER_STATE.AWAITING_MANUAL_PAYMENT:
      case ORDER_STATE.VALIDATING_PAN:
        await this._sendTpl(orderNo, 'waitProcessing');
        break;

      case ORDER_STATE.PAYMENT_SENT:
      case ORDER_STATE.WAITING_FOR_RELEASE:
        // If payment-provider hasn't confirmed the bank settlement yet
        // (paymentPending flag set when we entered the pending branch of
        // _processPaymentFlow), the seller MUST see "payment is processing"
        // not "payment has already been sent" — the latter is misleading
        // and gets the seller angry (per real complaints: "i didn't receive
        // the money" / "noo it's not done" / "I'll report you" while the
        // bot keeps insisting payment is done).
        //
        // Once payment-provider's webhook calls finalizePayoutSuccess(), the flag
        // is cleared and subsequent seller messages get the standard
        // waitRelease template with the real UTR already in chat history.
        if (order.paymentPending) {
          await this._sendTpl(orderNo, 'paymentProcessing');
        } else {
          await this._sendTpl(orderNo, 'waitRelease');
        }
        break;

      default:
        await this._sendTpl(orderNo, 'panNotFound');
    }
  }

  // ── Handle PAN reply ──────────────────────────────────────────────────────
  async _handlePANReply(orderNo, text) {
    const pan = extractPAN(text);

    if (!pan) {
      await this._sendTpl(orderNo, 'panNotFound');
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
          await this._sendTpl(orderNo, 'panMaxRetries');
          await this._escalateAndCancel(orderNo, `Max PAN retries (${retries})`);
        } else {
          stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
          // Route by failure source so seller sees the most actionable message
          if (result.source === 'format') {
            await this._sendTpl(orderNo, 'panInvalidFormat');
          } else {
            await this._sendTpl(orderNo, 'panApiInvalid', { reason: result.reason || '' });
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
      //   Step 1: Binance KYC name ↔ PAN name
      //   Step 2: Binance KYC name ↔ Bank account holder name
      //
      // Rationale: anchor on the Binance KYC name in BOTH steps because a
      // fraudster cannot easily change their Binance-verified identity, but
      // can submit any PAN. Confirming the same KYC identity against (a)
      // the PAN record and (b) the bank account holder gives two
      // independent fraud signals.
      //
      // If either step fails the order goes back to WAITING_FOR_PAN and the
      // seller is asked to retry with a correct PAN (up to maxPanRetries).
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
        // Surepass bank verification — POST to /api/v1/bank-verification/
        // returns `data.full_name`, i.e. the name registered with the bank.
        // More trustworthy than the seller-supplied account-holder name
        // Binance ships in the order detail. Falls back to the Binance-
        // provided name on any failure (no credentials, bad IFSC, account
        // not found, network, rate limit). The existing flow (mismatch →
        // ask for a different PAN) still kicks in if names don't match.
        const acc  = refreshed.paymentDetails?.accountNo;
        const ifsc = refreshed.paymentDetails?.ifscCode;
        const binanceProvidedName = refreshed.paymentDetails?.accountName?.trim() || '';

        let accountName       = binanceProvidedName;
        let accountNameSource = 'binance_order_detail';
        let bankVerify        = null;

        // Operator-controlled toggle (Overview → Bank Verify).
        // OFF (default) → use Binance-provided account holder name only.
        // ON            → call Surepass for the bank-side name, fall back
        //                 to Binance-provided on any failure.
        let bankVerifyEnabled = false;
        try {
          bankVerifyEnabled = await botStatusService.isBankVerifyEnabled();
        } catch (_) { /* default OFF on DB hiccup */ }

        if (bankVerifyEnabled && acc && ifsc) {
          bankVerify = await bankVerificationService.verifyBankAccount({
            accountNumber: acc,
            ifsc,
            name:          panName,
            orderNo,
          });
          if (bankVerify.ok && bankVerify.nameAtBank) {
            accountName       = bankVerify.nameAtBank.trim();
            accountNameSource = 'surepass_bank_verification';
            logger.info('Account holder name overridden by Surepass bank verification', {
              orderNo,
              surepassNameAtBank: bankVerify.nameAtBank,
              binanceProvidedName,
              bankName:           bankVerify.bankName  || '(n/a)',
              branchName:         bankVerify.branchName || '(n/a)',
              referenceId:        bankVerify.referenceId || '(n/a)',
            });
          } else {
            logger.warn('Surepass bank verification unavailable — falling back to Binance-provided account name', {
              orderNo,
              reason:              bankVerify.reason || 'unknown',
              binanceProvidedName: binanceProvidedName || '(none)',
            });
          }
        } else if (!bankVerifyEnabled) {
          logger.info('Bank verification toggle is OFF — using Binance-provided account name', {
            orderNo,
            binanceProvidedName: binanceProvidedName || '(none)',
          });
        } else {
          logger.info('Skipping Surepass bank verification — no account+ifsc on order', {
            orderNo,
            hasAccount: !!acc,
            hasIfsc:    !!ifsc,
            hasUpi:     !!refreshed.paymentDetails?.upiId,
          });
        }

        // Don't compare against the seller's nickname (it's a screen name)
        const kycUsable = kycName && kycName !== refreshed.sellerNickname;

        // Step 1: Binance KYC name ↔ PAN name (symmetric, token-intersection
        // doesn't care about argument order — labels reflect the anchor).
        let kycCheck = null;
        if (kycUsable) {
          kycCheck = tokenIntersectionMatch(kycName, panName);
          logger.info('Name match Step 1 — Binance KYC ↔ PAN', {
            orderNo,
            kycName,
            panName,
            matched: kycCheck.matched,
            overlap: kycCheck.overlap,
            reason:  kycCheck.reason,
          });
        }

        // Step 2: Binance KYC name ↔ Bank account holder name
        // Source: Surepass bank verification when available, else Binance
        // order detail. Compares the seller's Binance KYC name against the
        // name actually registered with the bank — a stronger fraud check
        // than PAN-vs-bank, because a fraudster may have a real PAN but
        // can't change their Binance KYC identity to match a stolen bank
        // account.
        let bankCheck = null;
        if (accountName && kycUsable) {
          bankCheck = tokenIntersectionMatch(kycName, accountName);
          logger.info('Name match Step 2 — Binance KYC ↔ Bank Holder', {
            orderNo,
            kycName,
            accountName,
            source:  accountNameSource,
            matched: bankCheck.matched,
            overlap: bankCheck.overlap,
            reason:  bankCheck.reason,
          });
        } else if (accountName && !kycUsable) {
          logger.warn('Name match Step 2 SKIPPED — KYC name unusable, cannot compare against bank holder', {
            orderNo,
            accountName,
            sellerNickname: refreshed.sellerNickname || '(none)',
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
              const failedLabels    = failed.map((c) => c.label);
              const panFailed       = failedLabels.includes('binance_kyc');
              const onlyBankFailed  = !panFailed && failedLabels.includes('bank_account_holder');

              // Send the standard "names don't match" notification regardless.
              // panName / kycName / accountName are passed as extras because
              // they're the freshly-computed values from this verification
              // attempt (the order state doesn't have panName yet).
              await this._sendTpl(orderNo, 'nameMismatch', {
                panName,
                kycName:     kycUsable ? kycName : '—',
                accountName: accountName || '—',
                mismatchedSources,
              });

              if (onlyBankFailed) {
                // KYC ↔ PAN matches but KYC ↔ Bank Holder doesn't. Most
                // likely the seller's Binance ad has stale bank info — give
                // them up to MAX_BANK_RETRIES (default 2) chances to send
                // correct bank account number + IFSC in chat for re-verify.
                logger.info(
                  'Name match — only Bank Holder mismatched, starting bank-retry flow',
                  { orderNo, panName, kycName, accountName }
                );

                // PAN was already validated this attempt — stamp it on state
                // so the TDS consent flow has what it needs after recovery.
                const tds = calculateTDS(order.amount, config.bot.tdsPercent);
                stateManager.set(orderNo, ORDER_STATE.PAN_VERIFIED, {
                  pan, tds, panName: result.name || null,
                });
                this._clearPANTimers(orderNo);

                await sleep(1000);
                await this._sendTpl(orderNo, 'bankAccountRequest');
                stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_BANK_ACCOUNT, {
                  bankRetries: 0,
                });
                return;
              }

              // PAN ↔ KYC failed (regardless of bank). Existing PAN-retry
              // flow — ask for a different PAN, escalate + cancel on Binance
              // after maxPanRetries attempts (per business rule).
              const retries = stateManager.incPanRetry(orderNo);
              if (retries >= config.bot.maxPanRetries) {
                this._clearPANTimers(orderNo);
                await this._sendTpl(orderNo, 'panMaxRetries');
                await this._escalateAndCancel(orderNo,
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

      // pan / panName / TDS amounts are now on the order state, so _buildVars
      // exposes them to every template below — no per-call vars needed.
      await this._sendTpl(orderNo, 'panVerifiedTds');
      await sleep(1500);

      // tdsInfo is multi-block: every variation the admin added in the Chat
      // Templates page is sent in order ({tds}/{quarter}/etc. all filled).
      await this._sendTplReliable(orderNo, 'tdsInfo');

      await this._sendTpl(orderNo, 'tdsConsent');

      stateManager.set(orderNo, ORDER_STATE.WAITING_TDS_CONSENT);

    } catch (err) {
      // Only thrown for true server failures (5xx, network) — Surepass-side
      // "invalid PAN" already returned valid:false above. Inform seller in
      // a human-readable way and keep state in WAITING_FOR_PAN so they can
      // retry once the verification system recovers.
      logger.error('PAN verification system error', { orderNo, error: err.message });
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN);
      await this._sendTpl(orderNo, 'panApiDown');
    }
  }

  // ── Handle TDS consent ────────────────────────────────────────────────────
  async _handleTDSConsent(orderNo, text) {
    if (!isAgreementMessage(text)) {
      await this._sendTpl(orderNo, 'tdsConsentRetry');
      return;
    }

    stateManager.set(orderNo, ORDER_STATE.TDS_ACCEPTED);
    await this._sendTpl(orderNo, 'consentReceived');
    await sleep(1000);
    await this._processPaymentFlow(orderNo);
  }

  // ── Bank account resubmit flow ───────────────────────────────────────────
  //   Triggered when KYC ↔ Bank Holder mismatched but KYC ↔ PAN passed.
  //   Seller is asked (via bankAccountRequest template) to send their
  //   correct bank account number + IFSC in chat. We parse it, re-run
  //   Surepass bank verification with the new details, and:
  //     • Match → overwrite paymentDetails (so payment-provider pays the new
  //                 account) and proceed to TDS consent.
  //     • Mismatch / parse fail → incBankRetry. Re-send the template
  //                 until config.bot.maxBankRetries hit, then
  //                 escalateAndCancel.
  async _handleBankAccountReply(orderNo, text) {
    const order = stateManager.get(orderNo);
    if (!order) return;

    const parsed = parseBankAccountInput(text);
    if (!parsed.accountNo || !parsed.ifsc) {
      logger.info('Bank-retry — parse failed', {
        orderNo, preview: String(text).substring(0, 80),
        gotAccountNo: parsed.accountNo || '(none)',
        gotIfsc:      parsed.ifsc      || '(none)',
      });
      return this._handleBankRetryFailure(orderNo, 'parse_fail');
    }

    logger.info('Bank-retry — parsed seller input', {
      orderNo,
      accountNo: `${parsed.accountNo.slice(0, 4)}…${parsed.accountNo.slice(-4)}`,
      ifsc:      parsed.ifsc,
    });

    let bankVerify;
    try {
      bankVerify = await bankVerificationService.verifyBankAccount({
        accountNumber: parsed.accountNo,
        ifsc:          parsed.ifsc,
        orderNo,
      });
    } catch (err) {
      logger.error('Bank-retry — Surepass call threw', { orderNo, error: err.message });
      return this._handleBankRetryFailure(orderNo, 'surepass_error');
    }

    if (!bankVerify.ok || !bankVerify.nameAtBank) {
      logger.warn('Bank-retry — Surepass returned no usable result', {
        orderNo, reason: bankVerify.reason || 'unknown',
      });
      return this._handleBankRetryFailure(orderNo, bankVerify.reason || 'verify_fail');
    }

    // Compare new bank-side name against Binance KYC name
    const kycName        = (order.sellerName || '').trim();
    const newAccountName = bankVerify.nameAtBank.trim();
    const bankCheck      = tokenIntersectionMatch(kycName, newAccountName);

    logger.info('Bank-retry — name match attempt (Binance KYC ↔ new Bank Holder)', {
      orderNo,
      kycName,
      newAccountName,
      matched: bankCheck.matched,
      overlap: bankCheck.overlap,
      reason:  bankCheck.reason,
    });

    if (!bankCheck.matched) {
      return this._handleBankRetryFailure(orderNo, 'name_mismatch');
    }

    // ─── Bank-retry SUCCESS ───────────────────────────────────────────────
    // Overwrite paymentDetails with the seller's freshly-provided info so
    // payment-provider pays into THIS account, NOT the stale Binance order-detail
    // info. The `paymentDetailsOverridden: true` flag tells _processPaymentFlow
    // to skip its usual re-fetch from Binance and use these details as-is.
    const existingDetails = order.paymentDetails || {};
    const updatedDetails  = {
      ...existingDetails,
      accountNo:   parsed.accountNo,
      ifscCode:    parsed.ifsc,
      accountName: newAccountName,
      bankName:    bankVerify.bankName || existingDetails.bankName || null,
    };
    stateManager.set(orderNo, order.state, {
      paymentDetails:           updatedDetails,
      paymentDetailsOverridden: true,            // ← critical: lock these details in
    });
    orderDb.updateOrder(orderNo, {
      account_no:                parsed.accountNo,
      ifsc_code:                 parsed.ifsc,
      account_name:              newAccountName,
      bank_name:                 bankVerify.bankName || null,
      name_match_status:         'MATCH',
      name_match_compare_source: 'bank_retry_via_surepass',
    });

    logger.info('Bank-retry — match confirmed, proceeding to TDS consent', {
      orderNo,
      accountNo: `${parsed.accountNo.slice(0, 4)}…${parsed.accountNo.slice(-4)}`,
      ifsc:      parsed.ifsc,
      bankName:  bankVerify.bankName || '(n/a)',
    });

    await this._proceedToTdsConsent(orderNo);
  }

  // ── Bank-retry failure step ──────────────────────────────────────────────
  //   incBankRetry + decide: re-prompt or terminate. Used for parse-fail,
  //   Surepass error, and name-mismatch — all three "didn't work" cases.
  async _handleBankRetryFailure(orderNo, reason) {
    const retries     = stateManager.incBankRetry(orderNo);
    const maxRetries  = config.bot.maxBankRetries;
    logger.warn('Bank-retry — attempt failed', {
      orderNo, reason, retries, maxRetries,
    });

    if (retries >= maxRetries) {
      this._clearPANTimers(orderNo);
      await this._sendTpl(orderNo, 'panMaxRetries');
      await this._escalateAndCancel(orderNo,
        `Bank-retry exhausted (${retries}/${maxRetries}): ${reason}`
      );
    } else {
      await this._sendTpl(orderNo, 'bankAccountRequest');
      // Stay in WAITING_FOR_BANK_ACCOUNT — next seller msg routes here again
    }
  }

  // ── PAN verified → TDS consent (shared by initial flow + bank-retry) ────
  async _proceedToTdsConsent(orderNo) {
    const order = stateManager.get(orderNo);
    if (!order) return;

    // Returning-seller branch: if this order was identified as a returning
    // seller (previousOrderNo set by _handleReturningSeller), they've
    // already given TDS consent on a prior order — skip the consent prompt,
    // send the consolidated returningSellerTdsApplied template, auto-accept
    // and go straight to payment.
    //
    // This branch is hit when:
    //   • Returning seller's bank info changed (Option B re-verify)
    //   • → routed into bank-retry flow (WAITING_FOR_BANK_ACCOUNT)
    //   • → seller provides correct bank info → _handleBankAccountReply
    //   • → that calls _proceedToTdsConsent (us)
    if (order.previousOrderNo) {
      logger.info(
        '_proceedToTdsConsent — returning-seller path (bank-retry recovered)',
        { orderNo, previousOrderNo: order.previousOrderNo }
      );
      const kycName = (order.sellerName || order.panName || '').trim() || 'Customer';
      await this._sendTplReliable(orderNo, 'returningSellerTdsApplied', {
        previousOrderNo: order.previousOrderNo,
        kycName,
        sellerNickname:  order.sellerNickname || '—',
      });
      stateManager.set(orderNo, ORDER_STATE.TDS_ACCEPTED);
      await sleep(500);
      await this._processPaymentFlow(orderNo);
      return;
    }

    // First-time seller — standard TDS consent prompt flow
    await this._sendTpl(orderNo, 'panVerifiedTds');
    await sleep(1500);
    await this._sendTplReliable(orderNo, 'tdsInfo');
    await this._sendTpl(orderNo, 'tdsConsent');

    stateManager.set(orderNo, ORDER_STATE.WAITING_TDS_CONSENT);
  }

  // ── Escalate AND cancel the order on Binance ─────────────────────────────
  //   Stronger than _escalate — used after MAX retry exhaustion (PAN or
  //   bank). Sends the escalated chat, disconnects the WSS handler, then
  //   issues the seller-fault cancel reason to Binance. If Binance refuses
  //   (already past WAIT_PAYMENT), state stays ESCALATED for operator
  //   manual appeal.
  async _escalateAndCancel(orderNo, reason) {
    const order = stateManager.get(orderNo);
    if (!order) return;
    if (order.state === ORDER_STATE.CANCELLED || order.state === ORDER_STATE.FAILED) {
      logger.info('escalateAndCancel: already terminal — skipping', {
        orderNo, state: order.state, reason,
      });
      return;
    }

    logger.warn('Order escalating + cancelling on Binance', { orderNo, reason });

    stateManager.set(orderNo, ORDER_STATE.ESCALATED);
    await this._sendTpl(orderNo, 'escalated');
    this._clearCancelTimer(orderNo);
    this._clearPANTimers(orderNo);

    // Use the existing rotating "Due to seller" reason codes so the bot's
    // own cancellation rate isn't dinged (codes 3/4/6 are attributed to
    // the seller per Binance v7.4 rules).
    try {
      const picked = pickSellerCancelReason();
      await cancelOrder(orderNo, picked.code, String(picked.info || '').slice(0, 200));
      stateManager.set(orderNo, ORDER_STATE.CANCELLED, { cancel_reason: reason });
      logger.warn('Order cancelled on Binance via escalateAndCancel', {
        orderNo, reason, reasonCode: picked.code,
      });
    } catch (cancelErr) {
      logger.error('Cancel-on-escalate failed — order stays ESCALATED', {
        orderNo, reason, error: cancelErr.message,
        action: 'Operator: open Binance dashboard → Orders → this order → Appeal',
      });
      // State already ESCALATED from above — leave it there.
    }

    chatService.disconnect(orderNo);
  }

  // ── Payment flow — Req #3, #4 ─────────────────────────────────────────────
  //
  //   Sequence (per business rule: mark paid immediately on "I agree"):
  //     1. Fetch seller payment details from Binance order detail.
  //     2. markOrderAsPaid on Binance IMMEDIATELY — without a UTR.
  //        Binance auto-cancel is now disarmed; seller sees the order
  //        flip to "Paid" on their UI. We'll attach the real UTR to the
  //        chat template once payment-provider confirms.
  //     3. Call payment-provider (75-sec poll).
  //     4. Branch on the result:
  //          MANUAL  → AWAITING_MANUAL_PAYMENT, operator pays via admin UI
  //          PENDING → paymentProcessing template, await webhook
  //          SUCCESS → paymentSent template with real UTR
  //          FAILED  → paymentFailed template + force-cancel on Binance
  //                    (cancel may fail because we already markPaid'd;
  //                    operator must then manually appeal)
  async _processPaymentFlow(orderNo) {
    const order = stateManager.get(orderNo);

    try {
      stateManager.set(orderNo, ORDER_STATE.PROCESSING_PAYMENT);

      // Req #3: resolve seller payment details.
      //
      //   Priority:
      //     1. order.paymentDetails on state IF the bank-retry flow
      //        previously overrode it with seller-provided + Surepass-
      //        verified info (flag: paymentDetailsOverridden=true).
      //        payment-provider MUST pay to the seller-entered account, not the
      //        stale Binance order-detail bank info.
      //     2. Otherwise fetch fresh from Binance via getOrderDetail.
      let payDetails;
      if (order.paymentDetailsOverridden && order.paymentDetails?.accountNo && order.paymentDetails?.ifscCode) {
        payDetails = order.paymentDetails;
        logger.info('Using seller-overridden paymentDetails from bank-retry flow', {
          orderNo,
          accountNo: `${payDetails.accountNo.slice(0, 4)}…${payDetails.accountNo.slice(-4)}`,
          ifsc:      payDetails.ifscCode,
          source:    'bank_retry_via_surepass',
        });
      } else {
        const orderDetail = await getOrderDetail(orderNo);
        payDetails        = extractPaymentDetails(orderDetail);
        logger.info('Seller payment details fetched from Binance order detail', {
          orderNo,
          method: payDetails.methodName,
          isUPI:  payDetails.isUPI,
        });
      }

      stateManager.set(orderNo, ORDER_STATE.PROCESSING_PAYMENT, {
        paymentDetails: payDetails,
        payMethod:      payDetails.methodName,
      });

      // ── EARLY markOrderAsPaid ──────────────────────────────────────────
      // Fire immediately, before payment-provider. No UTR yet — Binance just shows
      // the order as "Paid" without a specific reference. The real UTR is
      // delivered to the seller via the paymentSent chat template once
      // payment-provider confirms. This preempts Binance's notify_pay_end_time
      // auto-cancel during the 75-sec payment-provider poll.
      //
      // Sets `paidOnBinance: true` in state so _autoCancel's data-guard sees
      // this commit and refuses to cancel the order from this point on
      // (per business rule: once markPaid is called, only an explicit payout
      // failure may cancel — never the timeout-driven auto-cancel).
      try {
        await markOrderAsPaid(orderNo, payDetails.payId, null);
        stateManager.set(orderNo, stateManager.get(orderNo)?.state, {
          paidOnBinance: true,
        });
        logger.info('Order marked as paid on Binance (early — pre-payment-provider)', {
          orderNo, payId: payDetails.payId,
        });
      } catch (err) {
        logger.error('Early markOrderAsPaid failed — continuing to payment-provider anyway', {
          orderNo, error: err.message,
        });
      }

      // Req #4: auto-pay via payment-provider (or manual fallback)
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
        //   upi_only → seller gave UPI only (payment-provider wallet can't pay UPI)
        //   else     → generic "payment is being prepared" (no_credentials /
        //              toggle_off / bad_name / bad_ifsc / bad_account)
        // There is no "above_limit" branch any more — IMPS/NEFT/RTGS in
        // bot_config cover every amount band, so a large transfer routes to
        // RTGS instead of falling back to manual.
        if (result.reason === 'upi_only') {
          await this._sendTpl(orderNo, 'manualPaymentUpi');
        } else {
          await this._sendTpl(orderNo, 'manualPaymentPending');
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
      // payment-provider accepted the transfer but the bank hasn't confirmed yet.
      // markOrderAsPaid already fired pre-payment-provider (above) so Binance auto-
      // cancel is disarmed. Just record state + send the processing template
      // and wait for payment-provider's webhook to resolve to success or failed.
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

        // method passed explicitly so {method} shows the payment-provider mode
        // (IMPS/NEFT/RTGS) chosen for THIS transfer.
        await this._sendTpl(orderNo, 'paymentProcessing', { method: result.mode });

        stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_RELEASE, {
          paymentPending: true,
        });

        logger.info('Payment PENDING — awaiting payment-provider webhook', {
          orderNo,
          transferId: result.transferId || result.payoutId,
          mode:       result.mode,
          amount:     order.tds.postTDS,
        });
        return;
      }

      // Auto-payment succeeded immediately. Mark state, persist payout,
      // then ensure the auto-cancel timer never fires for this order again.
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

      // Best-effort: re-call markOrderAsPaid with the real UTR so it shows
      // on Binance's seller-side UI as the payment proof. Binance may
      // ignore the second call (order already in PAID state) — that's fine,
      // the chat template below carries the UTR authoritatively.
      try {
        await markOrderAsPaid(orderNo, payDetails.payId, result.utr);
      } catch (err) {
        logger.warn('Second markOrderAsPaid (with real UTR) was rejected — UTR still in chat template', {
          orderNo, error: err.message,
        });
      }

      // Race-condition guard: payment-provider can fire TRANSFER_SUCCESS webhook
      // CONCURRENTLY with this immediate-success poll result. The webhook
      // handler (finalizePayoutSuccess) and this code both want to send
      // the same paymentSent template. paymentSentTemplateFired is the
      // shared flag — whoever wins the race fires once, the loser sees
      // the flag set and skips. Without this guard the seller gets the
      // exact same paymentSent template TWICE in chat.
      //
      // SET-BEFORE-SEND: we flip the flag BEFORE awaiting the send so any
      // other tick that lands during the await sees the flag and skips.
      // If we set it after, both paths could pass their check before either
      // had a chance to record they're firing.
      const stateBeforeSend = stateManager.get(orderNo);
      if (stateBeforeSend?.paymentSentTemplateFired) {
        logger.info('paymentSent template already fired by webhook race — skipping immediate-success send', {
          orderNo, utr: result.utr,
        });
        stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_RELEASE);
        return;
      }

      // Reserve the right to send by flipping the flag synchronously
      // (Object.assign in stateManager.set is sync), THEN await the send.
      stateManager.set(orderNo, ORDER_STATE.PAYMENT_SENT, {
        paymentSentTemplateFired: true,
      });

      // method + utr passed explicitly so {method} reflects the payment-provider
      // transfer mode and {utr} the real UTR (both also on the state now).
      await this._sendTpl(orderNo, 'paymentSent', {
        method: result.mode,
        utr:    result.utr,
      });

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
      await this._sendTpl(orderNo, 'paymentFailed');

      // payment-provider returned a HARD failure (FAILED / REJECTED / REVERSED) on
      // the initial poll → cancel the order on Binance per business rule.
      //
      // We DELIBERATELY skip canCancelOrder here. Because markOrderAsPaid
      // already fired at the top of this flow, the Binance order is in
      // status 2 (PAID) and canCancelOrder returns false. But the real
      // cancelOrder endpoint may still accept a "Due to seller" reason
      // code (code 6 = "Seller cannot release" — designed for post-
      // payment scenarios). Use the existing rotating seller-fault reason
      // picker exactly like the auto-cancel path does.
      try {
        const picked = pickSellerCancelReason();
        await cancelOrder(orderNo, picked.code, String(picked.info || '').slice(0, 200));
        stateManager.set(orderNo, ORDER_STATE.CANCELLED);
        logger.warn('Order cancelled on Binance after payment-provider hard fail', {
          orderNo, reason: err.message, reasonCode: picked.code,
        });
      } catch (cancelErr) {
        // Binance refused — order remains in PAID state on their side.
        // Operator must manually appeal via Binance dashboard.
        logger.error('💥 CRITICAL: Cancel rejected after early markPaid + payment-provider fail — operator must appeal manually', {
          orderNo,
          providerError: err.message,
          cancelError:   cancelErr.message,
          action:        'Open Binance merchant dashboard → Orders → this order → Appeal',
        });
      }
    }
  }

  // ── Finalize a PENDING payout when payment-provider's webhook confirms SUCCESS ──
  //   Called by paymentWebhookController. Idempotent — skips if we've
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
    // Idempotency #1: chat template already fired (by ourselves via webhook
    // replay OR by the immediate-success path in _processPaymentFlow).
    // paymentSentTemplateFired is the shared flag — see _processPaymentFlow
    // race-condition guard for the full explanation.
    if (order.paymentSentTemplateFired) {
      logger.info('finalizePayoutSuccess: paymentSent already fired — skipping (idempotent)', {
        orderNo, existingUtr: order.utr || '(none)',
      });
      // Still mirror the real UTR if we have it and the state row didn't
      // get it yet (extra safety for the immediate-success race where
      // template fired with utr but webhook arrives with confirming UTR).
      if (realUtr && (!order.utr || String(order.utr).startsWith('PEND-'))) {
        stateManager.set(orderNo, order.state, { utr: realUtr, paymentPending: false });
      }
      return;
    }
    // Idempotency #2: stored utr is already a real (non-PEND-) value AND
    // template has been fired (covered above). If utr is real but flag
    // is somehow unset, we DO still send so the seller gets at least one
    // confirmation.
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

    // Mark template-fired BEFORE the await so the concurrent immediate-
    // success path sees the flag and skips. Without this set-before-send
    // pattern, both paths could pass their guard before either sends.
    stateManager.set(orderNo, order.state, {
      utr:                      realUtr,
      paymentPending:           false,
      paymentSentTemplateFired: true,
    });

    const effectiveMode = mode || order.paymentMode || 'IMPS';

    await this._sendTplReliable(orderNo, 'paymentSent', {
      method: effectiveMode,
      utr:    realUtr,
    });

    logger.info('Pending payout FINALIZED as SUCCESS', {
      orderNo,
      realUtr,
      mode: effectiveMode,
    });
  }

  // ── Finalize a PENDING payout when payment-provider's webhook reports FAILURE ───
  //   Called by paymentWebhookController. Per business rule:
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

    await this._sendTplReliable(orderNo, 'paymentFailed');

    // We DELIBERATELY skip canCancelOrder here. After markOrderAsPaid (which
    // we called when the pending branch fired in _processPaymentFlow), the
    // Binance order is in status 2 (PAID) and canCancelOrder will return
    // false — but the cancelOrder endpoint MAY still accept a "Due to
    // seller" reason code (Binance reserves code 6 for "seller cannot
    // release" specifically for post-payment scenarios). Always attempt
    // the real cancel and let Binance be the source of truth.
    let cancelled = false;
    try {
      const picked = pickSellerCancelReason();
      await cancelOrder(orderNo, picked.code,
        `payment-provider payout failed: ${String(reason || '').slice(0, 150)}`
      );
      cancelled = true;
      stateManager.set(orderNo, ORDER_STATE.CANCELLED, {
        cancel_reason: `payment-provider payout failed: ${reason || 'n/a'}`,
      });
      logger.warn('Order cancelled on Binance after payment-provider pending → fail', {
        orderNo, reason, reasonCode: picked.code,
      });
    } catch (cancelErr) {
      // Binance refused the cancel — most likely because the seller already
      // released crypto, or the order moved into appeal. Mark FAILED locally
      // and emit a critical log so the operator can manually appeal/refund
      // via Binance dashboard.
      logger.error('Cancel attempt after payment-provider pending → fail FAILED — operator must appeal manually', {
        orderNo,
        error:  cancelErr.message,
        reason,
        action: 'Open Binance merchant dashboard → Orders → this order → Appeal',
      });
      stateManager.set(orderNo, ORDER_STATE.FAILED, {
        cancel_reason: `payment-provider payout failed: ${reason || 'n/a'} (cancel rejected: ${cancelErr.message})`,
      });
    }

    if (!cancelled) {
      logger.error('💥 CRITICAL: Order in FAILED with payment already markPaid on Binance', {
        orderNo,
        reason,
        next: 'Operator must raise appeal on Binance dashboard to recover',
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
      await this._sendTpl(orderNo, 'orderCancelledRemote');
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
      await this._sendTpl(orderNo, 'panReminder');
    }, reminderMs);

    const lastWarningTimer = setTimeout(async () => {
      const o = stateManager.get(orderNo);
      if (!o || o.state !== ORDER_STATE.WAITING_FOR_PAN) return;
      stateManager.set(orderNo, ORDER_STATE.WAITING_FOR_PAN, { lastWarningSent: true });
      await this._sendTpl(orderNo, 'panLastWarning');
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
    await this._sendTpl(orderNo, 'escalated');
    this._clearCancelTimer(orderNo);
    this._clearPANTimers(orderNo);
    chatService.disconnect(orderNo);
  }

  // ── Send chat message helper ──────────────────────────────────────────────
  //  Low-level single-message send. Accepts a string OR Promise<string>.
  //  Most callers should use _sendTpl / _sendTplReliable (which render a
  //  template key with the global var map and handle multi-block sends).
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

  // ── Build the GLOBAL template variable map for an order ───────────────────
  //  Every template (welcome, panRequest, paymentSent, a custom one — any of
  //  them) is rendered with this same comprehensive var map, so an admin can
  //  use {pan}, {utr}, {tds}, {method}, etc. in ANY template and it gets the
  //  real value. Keep the keys here in exact sync with
  //  messageService.TEMPLATE_VARIABLES (the frontend variable palette).
  //
  //  `extras` always wins — used for values computed at the call site that
  //  aren't (yet) on the order state, e.g. a name-mismatch source list or a
  //  PAN-failure reason string.
  _buildVars(orderNo, extras = {}) {
    const order = stateManager.get(orderNo) || {};
    const tds   = order.tds || {};
    const pd    = order.paymentDetails || {};
    const realUtr = order.utr && !String(order.utr).startsWith('PEND-')
      ? order.utr
      : '';

    return {
      // Identity
      sellerName:      (order.sellerName || order.sellerNickname || 'Customer'),
      sellerNickname:  (order.sellerNickname || ''),
      kycName:         (order.sellerName || order.panName || order.sellerNickname || 'Customer'),
      orderNo:         String(orderNo),
      previousOrderNo: (order.previousOrderNo || '—'),

      // Amounts
      amount:          messageService.inr(order.amount),
      cryptoAmount:    (order.cryptoAmount != null ? String(order.cryptoAmount) : ''),
      asset:           (order.asset || 'USDT'),
      fiat:            (order.fiat || 'INR'),

      // PAN
      pan:             (order.pan || '—'),
      panName:         (order.panName || '—'),

      // TDS amounts (formatted)
      preTDS:          messageService.inr(tds.preTDS),
      tds:             messageService.inr(tds.tds),
      postTDS:         messageService.inr(tds.postTDS),

      // Payment
      method:          (order.paymentMode || order.payMethod || pd.methodName || 'Bank Transfer'),
      upi:             (pd.upiId || '—'),
      accountNo:       (pd.accountNo || ''),
      ifsc:            (pd.ifscCode || ''),
      bankName:        (pd.bankName || ''),
      accountName:     (pd.accountName || '—'),
      utr:             realUtr,
      tan:             (config.bot.tan || ''),

      // TDS timing (quarter / creditMonth / visibleMonth / year)
      ...messageService.tdsInfoVars(tds),

      // Call-site overrides
      ...extras,
    };
  }

  // ── Render + send a template by key with the GLOBAL var map ───────────────
  //  Sends EVERY message block configured for the key (multi-template
  //  support: add 1..N messages to any section in the Chat Templates page and
  //  they all go out, in step_order, with a short delay between each).
  //
  //  Returns true if all non-empty blocks were delivered.
  async _sendTpl(orderNo, templateKey, extras = {}) {
    const vars = this._buildVars(orderNo, extras);
    let blocks;
    try {
      blocks = await messageService.getAll(templateKey, vars);
    } catch (err) {
      logger.error('Template render failed', { orderNo, templateKey, error: err.message });
      return false;
    }
    if (!blocks || !blocks.length) {
      logger.warn('Template has no message blocks in DB', { orderNo, templateKey });
      return false;
    }
    let allOk = true;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      const ok = await this._send(orderNo, block);
      if (!ok) allOk = false;
      if (i < blocks.length - 1) await sleep(1200);
    }
    return allOk;
  }

  // ── Same as _sendTpl but each block is retried (critical templates) ───────
  //  Used for paymentSent / paymentFailed / thankYou / returning-seller where
  //  a dropped block mid-sequence would break the conversation.
  async _sendTplReliable(orderNo, templateKey, extras = {}) {
    const vars = this._buildVars(orderNo, extras);
    let blocks;
    try {
      blocks = await messageService.getAll(templateKey, vars);
    } catch (err) {
      logger.error('Template render failed', { orderNo, templateKey, error: err.message });
      return false;
    }
    if (!blocks || !blocks.length) {
      logger.warn('Template has no message blocks in DB', { orderNo, templateKey });
      return false;
    }
    let allOk = true;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      const ok = await this._sendReliable(orderNo, block);
      if (!ok) allOk = false;
      if (i < blocks.length - 1) await sleep(1200);
    }
    return allOk;
  }

  // ── Trade complete — Req #6: configurable thank-you ───────────────────────
  async complete(orderNo) {
    const order = stateManager.get(orderNo);
    if (!order) return;
    if (order.state === ORDER_STATE.COMPLETED) return;

    stateManager.set(orderNo, ORDER_STATE.COMPLETED);

    // Send all thank-you blocks the admin configured (any number of
    // variations in the Chat Templates page) — each fires sequentially with
    // a short delay. {asset}/{cryptoAmount}/{orderNo} (and every other
    // global var) are available.
    await this._sendTplReliable(orderNo, 'thankYou');

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
