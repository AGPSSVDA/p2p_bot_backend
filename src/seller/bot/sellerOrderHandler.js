const logger = require('../../utils/logger');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerAdService = require('../services/sellerAdService');
const sellerEligibilityService = require('../services/sellerEligibilityService');
const sellerBuyerMetricsService = require('../services/sellerBuyerMetricsService');
const { SellerStateManager, SELLER_ORDER_STATES } = require('./sellerStateManager');
const sellerVerificationService = require('../services/sellerVerificationService');
// Seller flows use the SELLER API key only (sellerBinanceService).
const sellerBinanceService = require('../services/sellerBinanceService');
// Chat SENDS go over the SELLER chat WSS with the SELLER key (sellerChatService).
const { sellerChatService } = require('../services/sellerChatService');
const sellerMethod2Service = require('../services/sellerMethod2Service');
const sellerMessageService = require('../services/sellerMessageService');
const sellerOtpService = require('../services/sellerOtpService');
const paymentGatewayService = require('../services/paymentGatewayService');
const qrService = require('../services/qrService');
// Loose (first-OR-last-name, case-insensitive) match for seller Method 3 payer
// vs KYC. Buyer-side helpers.matchNames() is left untouched.
const { matchNamesLoose: matchNames } = require('../utils/sellerUtils');

/**
 * Pick the first usable payId from candidates. A usable id is present and not 0
 * (UPI orders often carry payId:0, which is not the real payment-method id).
 * Returns null when none qualify.
 */
function pickPayId(...candidates) {
  for (const c of candidates) {
    if (c != null && Number(c) > 0) return c;
  }
  return null;
}

class SellerOrderHandler {
  constructor() {
    this.stateManager = new SellerStateManager();
    this.livenessTimers = {};
    this.documentTimers = {};
    this.otpTimers = {};
    this.paymentTimers = {};
    this.livenessPollers = {}; // Polling intervals for liveness check
    this.documentPollers = {}; // Polling intervals for Method 2 chat image collection
    this.otpPollers = {};      // Polling intervals for Method 2 OTP chat replies
    this.gatewayPollers = {};  // Polling intervals for Method 3 payment status
  }

  /**
   * Immediately stop ALL in-flight work — every liveness/document/payment poll
   * loop and timer across every order. Used when the seller bot is stopped.
   */
  stopAll() {
    const stores = [
      this.livenessPollers,
      this.documentPollers,
      this.otpPollers,
      this.gatewayPollers,
      this.livenessTimers,
      this.documentTimers,
      this.otpTimers,
      this.paymentTimers,
    ];
    let cleared = 0;
    for (const store of stores) {
      for (const key of Object.keys(store)) {
        // clearInterval and clearTimeout are interchangeable for either handle.
        clearInterval(store[key]);
        clearTimeout(store[key]);
        delete store[key];
        cleared++;
      }
    }
    logger.info(`[SellerHandler] stopAll — cleared ${cleared} active poller(s)/timer(s)`);
    return cleared;
  }

  /**
   * Send a chat message to the buyer on an order — over the SELLER chat WSS with
   * the SELLER key (sellerChatService). Accepts the object form { orderNo, content }.
   *
   * GUARD: once an order is finished (CANCELLED / REJECTED / COMPLETED) the bot
   * must go SILENT — no more replies, no matter what the buyer types. Otherwise a
   * buyer can keep chatting a dead order and get the bot to respond. We check the
   * order's current state right before sending and drop the message if it's over.
   */
  async _sendChat({ orderNo, content }) {
    if (!content) return { success: false, message: 'empty content' };
    try {
      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const st = dbOrder?.current_state;
      if (st === SELLER_ORDER_STATES.CANCELLED ||
          st === SELLER_ORDER_STATES.REJECTED ||
          st === SELLER_ORDER_STATES.COMPLETED) {
        logger.info(`[${orderNo}] Chat send skipped — order is ${st} (bot silent on finished orders)`);
        return { success: false, message: `order ${st}` };
      }
    } catch (e) {
      // If the state read fails, fall through and send (don't block on a DB hiccup).
    }
    try {
      const res = await sellerChatService.send(orderNo, content);
      if (!res?.success) {
        logger.warn(`[${orderNo}] Chat send returned non-success`, { message: res?.message });
      }
      return res;
    } catch (err) {
      logger.error(`[${orderNo}] Chat send failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * START: Called when new order is detected by sellerOrderPoller
   *
   * Parameters:
   * - rawOrder: Order data from Binance (orderNumber, counterPartNickName, etc)
   * - ad: Ad object (ad_no, seller_id, etc)
   * - adRules: Ad-specific configuration (11 eligibility rules + 3 methods with toggles)
   * - buyerMetrics: Buyer's 30-day metrics
   *
   * Flow: Store in DB → Step 2: Eligibility Check
   */
  async start(rawOrder, ad, adRules, buyerMetrics) {
    const orderNo = rawOrder.orderNumber;

    try {
      logger.info(`📦 Starting seller order handler`, {
        orderNo,
        buyer: rawOrder.counterPartNickName,
        ad: ad.ad_no,
        additionalKycVerify: rawOrder.additionalKycVerify
      });

      // Resolve buyer id across the various field names Binance returns.
      // Order detail uses takerUserNo; listOrders/other paths may use
      // counterPartUserId or buyerUserNo. buyer_id is NOT NULL in the DB, so
      // fall back to the order number to guarantee the insert never fails.
      const buyerId =
        rawOrder.counterPartUserId ||
        rawOrder.takerUserNo ||
        rawOrder.buyerUserNo ||
        `unknown-${orderNo}`;
      const buyerNickname =
        rawOrder.counterPartNickName || rawOrder.buyerNickname || 'Unknown';
      const buyerKycName = rawOrder.userFullName || rawOrder.buyerName || '(Unknown)';

      // Add to state manager
      this.stateManager.add({
        orderNumber: orderNo,
        sellerId: ad.seller_id,
        buyerId,
        buyerNickname,
        buyerKycName,
        adNo: ad.ad_no,
        cryptoAmount: rawOrder.amount,
        fiatAmount: rawOrder.totalPrice
      });

      // Persist to database
      await sellerOrderDbService.upsertOrder({
        orderNumber: orderNo,
        sellerId: ad.seller_id,
        buyerId,
        buyerNickname,
        buyerKycName,
        adNo: ad.ad_no,
        cryptoAmount: rawOrder.amount,
        fiatAmount: rawOrder.totalPrice,
        asset: rawOrder.asset,
        fiatUnit: rawOrder.fiat
      });

      // Store buyer metrics if provided
      if (buyerMetrics) {
        await sellerBuyerMetricsService.storeBuyerMetrics(
          rawOrder.counterPartUserId,
          buyerMetrics
        );
      }

      // ===== RE-ORDER COOLDOWN CHECK (per-ad, before any verification) =====
      // If the ad has the cooldown enabled and this buyer COMPLETED an order on
      // it within the configured window, block the new order. The window is
      // per-ad (reorder_cooldown_hours); default OFF unless the admin turns it on.
      const cooldownOn = adRules?.reorder_cooldown_enabled === 1 || adRules?.reorder_cooldown_enabled === true;
      const cooldownHours = Number(adRules?.reorder_cooldown_hours) > 0 ? Number(adRules.reorder_cooldown_hours) : 24;

      if (cooldownOn) {
        const recent = await sellerOrderDbService.getRecentCompletedOrderByBuyer(
          buyerId,
          orderNo,
          cooldownHours
        );
        if (recent) {
          const completedAt = new Date(recent.completed_at);
          const nextAllowed = new Date(completedAt.getTime() + cooldownHours * 60 * 60 * 1000);
          const hoursLeft = Math.max(
            1,
            Math.ceil((nextAllowed.getTime() - Date.now()) / (60 * 60 * 1000))
          );

          logger.info(`[${orderNo}] ⛔ Re-order cooldown (${cooldownHours}h): buyer completed order ${recent.order_number} recently`, {
            buyerId,
            previousOrder: recent.order_number,
            completedAt: recent.completed_at,
            cooldownHours,
            hoursLeft,
          });

          await this._sendChat({
            orderNo,
            content: await sellerMessageService.get(
              'seller_cooldown_24h',
              { hours: hoursLeft, cooldownHours },
              `You have already completed an order recently. ` +
                `Only one order per ${cooldownHours} hours is allowed. ` +
                `Please place a new order after ${hoursLeft} hour(s).`
            ),
            msgType: 'TEXT',
          });

          this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
          await sellerOrderDbService.setOrderState(
            orderNo,
            SELLER_ORDER_STATES.REJECTED,
            `Re-order cooldown: buyer completed a previous order within ${cooldownHours}h`
          );
          await sellerOrderDbService.recordError(
            orderNo,
            `Re-order cooldown (${cooldownHours}h) - previous order ${recent.order_number}`
          );
          return; // Do NOT proceed to liveness / any method
        }
      }

      // ===== VERIFICATION METHOD GATE =====
      // The bot only acts if the admin enabled a verification method on THIS ad.
      // If no method is enabled, the bot does NOTHING — it must never auto-verify
      // an order. (Binance's own liveness prompt is independent of our toggles;
      // we must not treat additionalKycVerify as permission to verify.)
      const method1On = adRules?.method1_liveness_enabled === 1 || adRules?.method1_liveness_enabled === true;
      const method2On = adRules?.method2_documents_enabled === 1 || adRules?.method2_documents_enabled === true;
      const method3On = adRules?.method3_full_enabled === 1 || adRules?.method3_full_enabled === true;

      if (!method1On && !method2On && !method3On) {
        logger.info(`[${orderNo}] ⏭️  No verification method enabled on ad ${ad.ad_no} — bot will NOT touch this order (no auto-verify)`);
        await sellerOrderDbService.setOrderState(
          orderNo,
          SELLER_ORDER_STATES.NEW_ORDER,
          'No verification method enabled — bot inactive for this ad'
        );
        return; // Do NOT verify, do NOT run liveness/documents.
      }

      // ===== METHOD 1: LIVENESS CHECK (only when a method is enabled) =====
      // Check liveness status and decide next step

      logger.info(`[${orderNo}] Checking liveness status`, {
        additionalKycVerify: rawOrder.additionalKycVerify,
        method1On, method2On, method3On,
      });

      if (rawOrder.additionalKycVerify === 2) {
        // ✅ Liveness already verified - proceed to order verification
        logger.info(`[${orderNo}] ✅ Liveness verified (additionalKycVerify = 2) - verifying order now`);

        await sellerOrderDbService.recordLivenessCompleted(orderNo, true);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_COMPLETED);

        // Verify order and proceed to payment
        await this.verifyOrderInBinance(orderNo);
        return;
      }

      if (rawOrder.additionalKycVerify === 1) {
        // ⏳ Liveness still pending - START POLLING
        logger.info(`[${orderNo}] ⏳ Liveness pending (additionalKycVerify = 1) - starting liveness polling`);

        // Start liveness polling - this will wait for buyer to complete
        await this.startLivenessPolling(orderNo, orderNo);
        return; // ← IMPORTANT: Don't continue to startVerification!
      }

      if (rawOrder.additionalKycVerify === 0) {
        // Liveness not required - proceed directly
        logger.info(`[${orderNo}] ✅ Liveness not required (additionalKycVerify = 0) - proceeding directly`);
        await this.verifyOrderInBinance(orderNo);
        return;
      }

      // Shouldn't reach here
      logger.warn(`[${orderNo}] Unknown additionalKycVerify status: ${rawOrder.additionalKycVerify}`);

    } catch (error) {
      logger.error(`Order handler error: ${error.message}`, { orderNo, error });
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.REJECTED);
    }
  }

  /**
   * ===== STEP 2: START VERIFICATION (Methods 1, 2, or 3) =====
   * Eligibility check already happened on Binance before order reached us
   */
  async startVerification(orderNo, adRules) {
    try {
      if (!adRules) {
        throw new Error('Ad rules not found');
      }

      logger.info(`[${orderNo}] Starting verification`, {
        method1: adRules.method1_liveness_enabled,
        method2: adRules.method2_documents_enabled,
        method3: adRules.method3_full_enabled
      });

      // ===== METHOD 1: LIVENESS ONLY =====
      if (adRules.method1_liveness_enabled) {
        await this.runLivenessVerification(orderNo);
        return;
      }

      // ===== METHOD 2/3: DOCUMENTS =====
      if (adRules.method2_documents_enabled || adRules.method3_full_enabled) {
        await this.runDocumentVerification(orderNo, adRules);
        return;
      }

      // No method enabled - error
      throw new Error('No verification method enabled for this ad');

    } catch (error) {
      logger.error(`Verification start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
    }
  }

  /**
   * ===== STEP 3A: LIVENESS VERIFICATION =====
   */
  async runLivenessVerification(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_LIVENESS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_LIVENESS);
      await sellerOrderDbService.recordLivenessRequested(orderNo);

      logger.info(`[${orderNo}] Waiting for liveness check completion...`);

      // Send message to buyer
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get(
          'seller_liveness_request',
          {},
          'Please complete the liveness check on Binance to proceed with your order.'
        ),
        msgType: 'TEXT'
      });

      // Start liveness polling to monitor chatUnreadCount and detect completion
      await this.startLivenessPolling(orderNo, null);

    } catch (error) {
      logger.error(`Liveness verification error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== METHOD 1: LIVENESS POLLING =====
   * Poll Binance every 5 seconds to check if buyer completed liveness
   *
   * IMPORTANT: We WAIT for Binance to auto-update additionalKycVerify from 1→2
   * We DO NOT call verifyAdditionalKyc() ourselves - that's wrong!
   * Only call it AFTER we confirm liveness is actually complete.
   */
  async startLivenessPolling(orderNo, adOrderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_LIVENESS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_LIVENESS);
      await sellerOrderDbService.recordLivenessRequested(orderNo);

      logger.info(`[${orderNo}] 🔄 Starting liveness polling (Method 1)...`, {
        adOrderNo
      });

      // Note: No message sent to buyer during liveness verification
      // Message will only be sent AFTER payment is complete (thank you message)

      let pollCount = 0;
      // Keep polling while the ORDER is still active on Binance — the buyer has
      // until Binance's own deadline to complete liveness. The bot stops (and
      // stays silent) once Binance cancels the order. MAX_POLLS is just a backstop
      // so an interval can't leak forever: default 600 polls = 30 min at 3s
      // (override with SELLER_LIVENESS_MAX_POLLS).
      const MAX_POLLS = Number(process.env.SELLER_LIVENESS_MAX_POLLS) || 600;

      // Start polling - PRIMARY signal is the Binance chat system message
      // "liveness_check_complete_maker". The additionalKycVerify field is NOT
      // reliable (it does not flip to 2 in real time), so we detect via chat.
      const pollInterval = setInterval(async () => {
        try {
          pollCount++;

          // ===== PRIMARY DETECTION: chat system message =====
          const livenessCheck = await sellerBinanceService.checkLivenessViaChat(orderNo);

          if (livenessCheck.success && livenessCheck.livenessComplete) {
            console.log(`[${orderNo}] ✅ LIVENESS COMPLETE! (chat signal "${livenessCheck.messageType}" after ${pollCount} polls)`);
            logger.info(`[${orderNo}] ✅ Liveness detected via chat message after ${pollCount} polls`, {
              messageType: livenessCheck.messageType
            });

            this._clearLivenessTimers(orderNo);
            await this.onLivenessCompleted(orderNo);
            return;
          }

          // ===== SECONDARY: honor additionalKycVerify if it happens to update =====
          // (0 = not required -> proceed; 2 = verified -> proceed). Also read the
          // order status so we can stop if Binance cancelled the order.
          const orderStatus = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
          const kycStatus = orderStatus?.success ? orderStatus.additionalKycVerify : undefined;
          const oStatus = orderStatus?.success ? orderStatus.orderStatus : undefined;

          if (kycStatus === 0 || kycStatus === 2) {
            console.log(`[${orderNo}] ✅ Proceeding via additionalKycVerify=${kycStatus} (after ${pollCount} polls)`);
            logger.info(`[${orderNo}] Proceeding via additionalKycVerify=${kycStatus}`);

            this._clearLivenessTimers(orderNo);
            await this.onLivenessCompleted(orderNo);
            return;
          }

          // ===== STOP ONLY when Binance cancelled the order (6/7) =====
          // Until then, the buyer still has time — keep waiting silently, do NOT
          // send a "cancelled/timeout" message.
          if (oStatus === 6 || oStatus === 7) {
            console.log(`[${orderNo}] Order cancelled on Binance (status ${oStatus}) — stopping liveness watch`);
            logger.info(`[${orderNo}] Order cancelled on Binance during liveness wait (status ${oStatus})`);
            this._clearLivenessTimers(orderNo);
            this.stateManager.setState(orderNo, SELLER_ORDER_STATES.CANCELLED);
            await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.CANCELLED, `Order cancelled on Binance (status ${oStatus}) during liveness wait`);
            return;
          }

          // Still pending — just wait. No message to the buyer.
          if (pollCount % 20 === 0 || pollCount <= 3) {
            console.log(`[${orderNo}] ⏳ Poll #${pollCount}: Liveness still pending (additionalKycVerify=${kycStatus}, orderStatus=${oStatus})`);
          }

          // Hard backstop only (should basically never hit — Binance cancels first).
          if (pollCount >= MAX_POLLS) {
            logger.warn(`[${orderNo}] Liveness watch backstop reached (${MAX_POLLS} polls) — stopping`);
            this._clearLivenessTimers(orderNo);
          }

        } catch (error) {
          logger.error(`[${orderNo}] Poll #${pollCount} - Error: ${error.message}`, { error });
          console.log(`[${orderNo}] Poll #${pollCount}: Error - ${error.message}, will retry...`);
        }
      }, 3000); // Poll every 3 seconds (balanced approach)

      this.livenessPollers[orderNo] = pollInterval;
      // NOTE: no forced liveness-timeout timer anymore. The poll loop above stops
      // itself only when liveness completes or Binance cancels the order. This is
      // what stops the bogus "Liveness still pending / order cancelled" message
      // from firing while the buyer still has time.

    } catch (error) {
      logger.error(`Liveness polling start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /** Clear the liveness poll interval + any legacy timer for an order. */
  _clearLivenessTimers(orderNo) {
    if (this.livenessPollers[orderNo]) {
      clearInterval(this.livenessPollers[orderNo]);
      delete this.livenessPollers[orderNo];
    }
    if (this.livenessTimers[orderNo]) {
      clearTimeout(this.livenessTimers[orderNo]);
      delete this.livenessTimers[orderNo];
    }
  }

  /**
   * Called when liveness check completes (detected via polling)
   */
  async onLivenessCompleted(orderNo) {
    try {
      logger.info(`[${orderNo}] Liveness check completed!`);

      // Clear polling interval
      if (this.livenessPollers[orderNo]) {
        clearInterval(this.livenessPollers[orderNo]);
        delete this.livenessPollers[orderNo];
      }

      // Clear timeout
      if (this.livenessTimers[orderNo]) {
        clearTimeout(this.livenessTimers[orderNo]);
        delete this.livenessTimers[orderNo];
      }

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_COMPLETED);
      await sellerOrderDbService.recordLivenessCompleted(orderNo, true);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_COMPLETED);

      // ===== METHOD 2: DOCUMENT IMAGES FROM CHAT =====
      // Method 2 = Method 1 (liveness) + document images. Only when admin enabled it.
      // Read adNo from the DB, not the in-memory state manager — after a restart
      // (or the resume path) the state manager is empty, which would leave adRules
      // null and silently skip Method 2 (the bug that left orders stuck in
      // WAITING_DOCUMENTS).
      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const adNo = dbOrder?.ad_no || this.stateManager.get(orderNo)?.adNo;
      const adRules = adNo ? await sellerOrderDbService.getAdRules(adNo) : null;

      // Method 2 OR Method 3 both require document verification after liveness.
      // (Method 3 = liveness + documents [+ OTP] + payment gateway.)
      if (adRules?.method2_documents_enabled || adRules?.method3_full_enabled) {
        logger.info(`[${orderNo}] Documents required (m2=${!!adRules?.method2_documents_enabled}, m3=${!!adRules?.method3_full_enabled}) - starting document verification`);
        await this.startMethod2Verification(orderNo);
        return; // Order is verified only after documents (and OTP/payment) pass
      }

      // ===== METHOD 1 OPTIONAL OTP =====
      // Method 1 = liveness only. If the admin turned on mobile OTP for this ad,
      // run the SAME OTP flow as Method 2 (ask mobile → NettyFish SMS → verify the
      // reply) right after liveness. startOtpVerification calls verifyOrderInBinance
      // itself once the OTP is confirmed, so we return here. When OTP is off, we
      // fall through and verify the order immediately after liveness (unchanged).
      const kycName = dbOrder?.buyer_kyc_name && dbOrder.buyer_kyc_name !== '(Unknown)'
        ? dbOrder.buyer_kyc_name : 'Customer';
      if (adRules?.method1_mobile_verification_enabled) {
        logger.info(`[${orderNo}] Method 1 OTP enabled — starting mobile OTP after liveness`);
        await this.startOtpVerification(orderNo, kycName, { method: 'method1' });
        return; // Order is verified only after OTP passes
      }

      // ===== STEP 4: ORDER VERIFICATION IN BINANCE =====
      await this.verifyOrderInBinance(orderNo);

    } catch (error) {
      logger.error(`Liveness completion error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== METHOD 2: DOCUMENT VERIFICATION (incremental, per-image) =====
   *
   * On entry: asks the buyer (in chat) to upload Aadhaar front, Aadhaar back and
   * PAN. Then polls the order chat and processes EACH new image individually
   * (sellerMethod2Service.processImage) — no image count is assumed; the buyer
   * may send documents in any order, any count, any layout.
   *
   * For every image:
   *   - classify + extract (OpenAI, one image),
   *   - Aadhaar front → name ⟷ KYC name → mark Aadhaar verified,
   *   - Aadhaar back  → mark seen,
   *   - PAN           → Surepass verify + name match → mark PAN verified,
   *   - anything else / unreadable → tell the buyer what's still needed.
   * A doc already verified is skipped (its later images are ignored). Each failed
   * read/match consumes an attempt; 3 attempts → limit exceeded → ask to cancel.
   * Once Aadhaar front + back + PAN are all done, the order is verified in Binance.
   *
   * Processed images are marked in the DB so we never re-classify (re-bill) the
   * same image, even across a restart.
   */
  async startMethod2Verification(orderNo, options = {}) {
    // `resuming` = true when the poller re-attaches after a restart. In that case
    // the buyer was already asked to upload documents, so we must NOT re-send the
    // entry prompt (that was the bug where the same message went out repeatedly).
    const resuming = options.resuming === true;
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);

      // Don't start a second poller for an order already being verified.
      if (this.documentPollers[orderNo]) {
        logger.debug(`[${orderNo}] Method 2 verification already running`);
        return;
      }

      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const buyerId = dbOrder?.buyer_id || this.stateManager.get(orderNo)?.buyerId;

      // Resolve the buyer's REAL KYC name from Binance order detail — name
      // matching is the whole point of Method 2, and the name stored at intake
      // is often "(Unknown)" because listOrders doesn't carry buyerName.
      let kycName = dbOrder?.buyer_kyc_name;
      if (!kycName || kycName === '(Unknown)') {
        try {
          const detail = await sellerBinanceService.getOrderDetail(orderNo);
          if (detail?.buyerName) {
            kycName = detail.buyerName;
            await sellerOrderDbService.updateBuyerKycName(orderNo, kycName);
          }
        } catch (e) {
          logger.warn(`[${orderNo}] Could not fetch KYC name for Method 2: ${e.message}`);
        }
      }

      logger.info(`[${orderNo}] 📄 Method 2 verification started`, { kycName });

      if (!kycName || kycName === '(Unknown)') {
        logger.error(`[${orderNo}] Method 2: no KYC name available — cannot name-match`);
      }

      let pollCount = 0;
      let lastMessage = null;       // de-dupe chat messages
      let busy = false;             // prevent overlapping AI calls
      const MAX_POLLS = 300;        // ~15 min at 3s

      const sendOnce = async (content) => {
        if (!content || content === lastMessage) return;
        lastMessage = content;
        await this._sendChat({ orderNo, content, msgType: 'TEXT' });
      };

      // ---- Ask the buyer to upload the documents (once, on entry) ----
      // Skip on resume (restart) — the buyer was already prompted; re-sending
      // would spam them the same message again.
      if (!resuming) {
        await this._sendChat({
          orderNo,
          content: await sellerMessageService.get(
            'seller_doc_upload_request',
            {},
            'Liveness verified ✓\n\nPlease upload the following for document verification:\n' +
              '1) Aadhaar card — front\n2) Aadhaar card — back\n3) PAN card\n\n' +
              'You can send them in any order.'
          ),
          msgType: 'TEXT',
        });
      }

      const pollInterval = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          pollCount++;

          // Fetch current chat images + store new ones (idempotent). Newly stored
          // images have verification_status = 'UPLOADED' until we process them.
          const imgs = await sellerBinanceService.getBuyerUploadedImages(orderNo);
          const images = imgs.success ? imgs.images : [];
          for (const image of images) {
            await sellerOrderDbService.saveChatImage(orderNo, buyerId, image);
          }

          // Process only images we haven't classified yet — one at a time.
          const pending = await sellerOrderDbService.getUnprocessedChatImages(orderNo);
          if (pending.length === 0) {
            // Nothing new to process. Remind what's still missing only occasionally
            // (~every 5 min at 3s interval) so we don't spam the buyer.
            if (pollCount > 0 && pollCount % 100 === 0) {
              const state = await sellerOrderDbService.getMethod2State(orderNo);
              const msg = await sellerMethod2Service.missingDocsMessage(state);
              if (msg) await sendOnce(msg);
            }
            return;
          }

          for (const img of pending) {
            // Stop early if the order got verified / failed mid-loop.
            if (!this.documentPollers[orderNo]) break;

            const result = await sellerMethod2Service.processImage(orderNo, kycName, img.image_url);

            // On a transient failure (couldn't download/classify), DON'T mark it
            // processed — leave it so the next poll retries this image.
            if (result.status === 'error') {
              if (pollCount % 20 === 0) {
                logger.debug(`[${orderNo}] Method 2: image ${img.id} classify error, will retry`, { detail: result.detail });
              }
              continue;
            }

            // Artificial OpenAI credit exhausted — send the generic message once
            // and stop the poller. Do NOT mark the image processed, so it is
            // re-processed once credit is topped up and the order resumes.
            if (result.status === 'unavailable') {
              logger.warn(`[${orderNo}] Method 2: OpenAI token limit exceeded — verification unavailable`);
              await sendOnce(result.message);
              this.stopMethod2Verification(orderNo);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS, 'OpenAI credit exhausted');
              return;
            }

            // Remember we processed this image (so we never re-bill it).
            await sellerOrderDbService.markImageProcessed(img.id, result.classifiedType || 'unknown');

            if (result.status === 'limit_exceeded') {
              logger.warn(`[${orderNo}] Method 2 attempt limit exceeded`);
              await sendOnce(result.message);
              this.stopMethod2Verification(orderNo);
              this.stateManager.setState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED, 'attempt limit exceeded');
              return;
            }

            // Send any per-image ERROR message (mismatch / unreadable /
            // not-a-document). We do NOT send "missing docs" here — that would
            // fire mid-batch when the buyer uploaded all images together and the
            // rest are still queued. Missing-docs is checked ONCE after the whole
            // batch below.
            if (result.message) await sendOnce(result.message);

            // After a successful doc step, check whether we're all done.
            if (['aadhaar_verified', 'aadhaar_back_seen', 'pan_verified'].includes(result.status)) {
              const state = await sellerOrderDbService.getMethod2State(orderNo);
              if (sellerMethod2Service.isComplete(state)) {
                logger.info(`[${orderNo}] ✅ Method 2 documents complete (Aadhaar front+back + PAN)`);
                this.stopMethod2Verification(orderNo);
                await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFIED);

                // If the ad requires mobile OTP (Method 2 OR Method 3), run it
                // BEFORE verifying. OTP is optional in both methods.
                const adRules = await sellerOrderDbService.getAdRules(dbOrder?.ad_no);
                if (adRules?.method2_mobile_verification_enabled || adRules?.method3_mobile_verification_enabled) {
                  logger.info(`[${orderNo}] OTP enabled — starting mobile OTP verification`);
                  await this.startOtpVerification(orderNo, kycName);
                  return;
                }

                await this.verifyOrderInBinance(orderNo);
                return;
              }
            }
          }

          // ===== After processing the WHOLE batch this cycle =====
          // Now that every image the buyer just sent has been processed, tell
          // them exactly what's still missing (once). This is what makes a
          // batch upload (all 3 at once) not spam "upload PAN / Aadhaar" for the
          // images that were actually in the batch.
          if (this.documentPollers[orderNo]) {
            const state = await sellerOrderDbService.getMethod2State(orderNo);
            if (!sellerMethod2Service.isComplete(state)) {
              const msg = await sellerMethod2Service.missingDocsMessage(state);
              if (msg) await sendOnce(msg);
            }
          }

          if (pollCount >= MAX_POLLS && this.documentPollers[orderNo]) {
            logger.info(`[${orderNo}] Method 2 verification window ended (timeout)`);
            this.stopMethod2Verification(orderNo);
            await sendOnce(await sellerMessageService.get('seller_doc_timeout', {}, 'Document verification timed out. You can cancel this order and try again.'));
            await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED, 'timeout');
          }
        } catch (error) {
          logger.error(`[${orderNo}] Method 2 poll error: ${error.message}`, { error });
        } finally {
          busy = false;
        }
      }, 3000);

      this.documentPollers[orderNo] = pollInterval;

    } catch (error) {
      logger.error(`Method 2 verification start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Stop the Method 2 verification poller.
   */
  stopMethod2Verification(orderNo) {
    if (this.documentPollers[orderNo]) {
      clearInterval(this.documentPollers[orderNo]);
      delete this.documentPollers[orderNo];
      logger.info(`[${orderNo}] Stopped Method 2 verification`);
    }
  }

  /**
   * ===== METHOD 2: OTP (MOBILE) VERIFICATION =====
   *
   * Runs after documents are verified, ONLY when the ad has
   * method2_mobile_verification_enabled. Asks the buyer for a 10-digit mobile
   * number, sends an OTP via SMS (NettyFish), then verifies the OTP the buyer
   * replies with in chat. All decision logic lives in sellerOtpService; this
   * poller just feeds it new buyer text messages and reacts to the result.
   */
  async startOtpVerification(orderNo, kycName, options = {}) {
    const resuming = options.resuming === true;
    // Which method triggered OTP — Method 1 uses a liveness-worded mobile prompt,
    // Method 2/3 keep the document-worded one. Only affects the first prompt text.
    const method = options.method;
    try {
      if (this.otpPollers[orderNo]) {
        logger.debug(`[${orderNo}] OTP verification already running`);
        return;
      }

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_MOBILE_OTP);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_MOBILE_OTP);
      await sellerOrderDbService.recordDocumentUploadRequested?.(orderNo, 'mobile');

      let pollCount = 0;
      let busy = false;
      let lastMessage = null;
      // Track which chat messages we've already handled so we never process one
      // twice.
      const processed = new Set();
      const MAX_POLLS = 300; // ~15 min at 3s

      // BASELINE: mark every chat message that already exists BEFORE we ask for
      // the mobile as "already seen", so earlier chit-chat ("bhai urgent hai",
      // "payment link") is NOT treated as mobile/OTP attempts. On a fresh entry
      // the buyer hasn't answered yet; only replies AFTER our prompt count. On a
      // resume we DON'T baseline (the buyer may have replied before restart) —
      // the DB state (mobileNumber/otpCode) prevents mis-processing there.
      //
      // Belt-and-suspenders: we ALSO record a cutoff time and ignore any message
      // whose createTime is at/older than it — so a message that was already sent
      // but hadn't propagated to the chat API at baseline-fetch time still can't
      // trigger a phantom "invalid mobile" attempt before the buyer replies.
      let promptCutoff = 0;
      if (!resuming) {
        try {
          const existing = await sellerBinanceService.getBuyerTextMessages(orderNo);
          for (const t of (existing.success ? existing.messages : [])) {
            processed.add(String(t.id));
            if (t.createTime && t.createTime > promptCutoff) promptCutoff = t.createTime;
          }
        } catch (e) { /* ignore — worst case we process a couple of old msgs */ }
        promptCutoff = Math.max(promptCutoff, Date.now() - 1000); // now-ish
      }

      // Ask for the mobile number (once, on entry). Skip on resume.
      if (!resuming) {
        await this._sendChat({
          orderNo,
          content: await sellerOtpService.mobileRequestMessage(method),
          msgType: 'TEXT',
        });
      }

      const sendOnce = async (content) => {
        if (!content || content === lastMessage) return;
        lastMessage = content;
        await this._sendChat({ orderNo, content, msgType: 'TEXT' });
      };

      const pollInterval = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          pollCount++;

          const resTexts = await sellerBinanceService.getBuyerTextMessages(orderNo);
          const texts = resTexts.success ? resTexts.messages : [];

          // Process only ONE new message per cycle (the oldest unprocessed one).
          // The bug: when several buyer messages were pending at once, a single
          // wrong reply got counted as 3 attempts and the buyer saw "Attempt
          // 1/3, 2/3, 3/3, limit exceeded" all at the same time. Handling one
          // message per 3s cycle makes each attempt a real, separate reply and
          // gives the buyer time to correct it. We also skip anything at/older
          // than the prompt cutoff (messages from before we asked for the mobile).
          const next = texts.find((t) =>
            !processed.has(String(t.id)) &&
            !(promptCutoff && t.createTime && t.createTime <= promptCutoff)
          );
          if (next) {
            processed.add(String(next.id));

            const result = await sellerOtpService.handleMessage(orderNo, next.content);

            if (result.status === 'verified') {
              logger.info(`[${orderNo}] ✅ OTP verified — verifying order`);
              this.stopOtpVerification(orderNo);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_VERIFIED);
              await this.verifyOrderInBinance(orderNo);
              return;
            }

            if (result.status === 'limit_exceeded') {
              logger.warn(`[${orderNo}] OTP verification limit exceeded`);
              await sendOnce(result.message);
              this.stopOtpVerification(orderNo);
              this.stateManager.setState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED, 'OTP attempt limit exceeded');
              return;
            }

            // otp_sent / invalid_mobile / invalid_otp / send_failed → tell the buyer.
            // ('ignored' → not a mobile/OTP-shaped reply; say nothing.)
            if (result.status !== 'ignored' && result.message) await sendOnce(result.message);
            // A fresh OTP was just sent → allow its confirm text to repeat later.
            if (result.status === 'otp_sent') lastMessage = null;
          }

          if (pollCount >= MAX_POLLS && this.otpPollers[orderNo]) {
            logger.info(`[${orderNo}] OTP verification window ended (timeout)`);
            this.stopOtpVerification(orderNo);
            this.stateManager.setState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED);
            await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED, 'OTP timeout');
          }
        } catch (error) {
          logger.error(`[${orderNo}] OTP poll error: ${error.message}`, { error });
        } finally {
          busy = false;
        }
      }, 3000);

      this.otpPollers[orderNo] = pollInterval;
    } catch (error) {
      logger.error(`OTP verification start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /** Stop the Method 2 OTP poller. */
  stopOtpVerification(orderNo) {
    if (this.otpPollers[orderNo]) {
      clearInterval(this.otpPollers[orderNo]);
      delete this.otpPollers[orderNo];
      logger.info(`[${orderNo}] Stopped OTP verification`);
    }
  }

  /**
   * Liveness timeout handler
   */
  startLivenessTimeout(orderNo) {
    const timeout = setTimeout(async () => {
      logger.warn(`[${orderNo}] Liveness check timeout!`);

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);

      // Send message
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get('seller_liveness_timeout', {}, 'Liveness check timeout. Your order has been cancelled. Please try again.'),
        msgType: 'TEXT'
      });

      delete this.livenessTimers[orderNo];

    }, 600000); // 10 minutes

    this.livenessTimers[orderNo] = timeout;
  }

  /**
   * ===== STEP 3B: DOCUMENT VERIFICATION =====
   */
  async runDocumentVerification(orderNo, adRules) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);

      logger.info(`[${orderNo}] Requesting document upload...`);

      // Send message to buyer
      await this._sendChat({
        orderNo,
        content: 'Please upload your Aadhaar card and PAN card for verification.',
        msgType: 'TEXT'
      });

      // Start document upload timeout (15 minutes)
      this.startDocumentTimeout(orderNo);

    } catch (error) {
      logger.error(`Document verification error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Called when documents are uploaded
   */
  async onDocumentsUploaded(orderNo, documents, adRules) {
    try {
      logger.info(`[${orderNo}] Documents uploaded, verifying...`);

      // Clear timeout
      if (this.documentTimers[orderNo]) {
        clearTimeout(this.documentTimers[orderNo]);
        delete this.documentTimers[orderNo];
      }

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_UPLOADED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_UPLOADED);

      // Verify documents via SurePass
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.VERIFYING_DOCUMENTS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.VERIFYING_DOCUMENTS);

      const verificationResult = await sellerVerificationService.verifyDocuments(
        orderNo,
        documents
      );

      if (!verificationResult.success) {
        logger.warn(`[${orderNo}] Document verification failed`, {
          reason: verificationResult.reason
        });

        // Send message
        await this._sendChat({
          orderNo,
          content: `Document verification failed: ${verificationResult.reason}. Please try again.`,
          msgType: 'TEXT'
        });

        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED);
        return;
      }

      logger.info(`[${orderNo}] ✅ Documents verified!`);

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFIED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFIED);

      // ===== STEP 3B OPTIONAL: MOBILE OTP =====
      if (adRules.method2_mobile_verification_enabled || adRules.method3_mobile_verification_enabled) {
        await this.runMobileOtpVerification(orderNo);
        return;
      }

      // No mobile OTP - proceed to Step 4
      await this.verifyOrderInBinance(orderNo);

    } catch (error) {
      logger.error(`Document verification error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== STEP 3B OPTIONAL: MOBILE OTP VERIFICATION =====
   */
  async runMobileOtpVerification(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_MOBILE_OTP);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_MOBILE_OTP);

      logger.info(`[${orderNo}] Requesting mobile number...`);

      // Send message
      await this._sendChat({
        orderNo,
        content: 'Please provide your mobile number for OTP verification.',
        msgType: 'TEXT'
      });

      // Start timeout
      this.startOtpTimeout(orderNo);

    } catch (error) {
      logger.error(`Mobile OTP error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Called when mobile number is provided
   */
  async onMobileNumberProvided(orderNo, mobileNumber) {
    try {
      logger.info(`[${orderNo}] Verifying mobile number via OTP...`);

      // Send OTP via Surepass
      const otpResult = await sellerVerificationService.sendMobileOtp(
        orderNo,
        mobileNumber
      );

      if (!otpResult.success) {
        logger.warn(`[${orderNo}] OTP send failed`, { reason: otpResult.reason });
        await this._sendChat({
          orderNo,
          content: 'Failed to send OTP. Please try again.',
          msgType: 'TEXT'
        });
        return;
      }

      // Send message
      await this._sendChat({
        orderNo,
        content: 'OTP sent to your mobile. Please reply with the OTP.',
        msgType: 'TEXT'
      });

    } catch (error) {
      logger.error(`Mobile OTP send error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Called when OTP is provided
   */
  async onOtpProvided(orderNo, otp) {
    try {
      logger.info(`[${orderNo}] Verifying OTP...`);

      // Clear timeout
      if (this.otpTimers[orderNo]) {
        clearTimeout(this.otpTimers[orderNo]);
        delete this.otpTimers[orderNo];
      }

      // Verify with Surepass
      const verification = await sellerVerificationService.verifyMobileOtp(orderNo, otp);

      if (!verification.success) {
        logger.warn(`[${orderNo}] OTP verification failed`);
        await this._sendChat({
          orderNo,
          content: 'Invalid OTP. Please try again.',
          msgType: 'TEXT'
        });
        return;
      }

      logger.info(`[${orderNo}] ✅ Mobile verified!`);

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_VERIFIED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_VERIFIED);
      await sellerOrderDbService.recordDocumentVerified(orderNo, 'mobile', true);

      // ===== STEP 4: ORDER VERIFICATION IN BINANCE =====
      await this.verifyOrderInBinance(orderNo);

    } catch (error) {
      logger.error(`OTP verification error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * OTP timeout handler
   */
  startOtpTimeout(orderNo) {
    const timeout = setTimeout(async () => {
      logger.warn(`[${orderNo}] OTP timeout!`);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.MOBILE_OTP_FAILED);
      delete this.otpTimers[orderNo];
    }, 300000); // 5 minutes

    this.otpTimers[orderNo] = timeout;
  }

  /**
   * Document timeout handler
   */
  startDocumentTimeout(orderNo) {
    const timeout = setTimeout(async () => {
      logger.warn(`[${orderNo}] Document upload timeout!`);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_DOCUMENTS);
      delete this.documentTimers[orderNo];
    }, 900000); // 15 minutes

    this.documentTimers[orderNo] = timeout;
  }

  /**
   * ===== STEP 4: VERIFY ORDER IN BINANCE =====
   */
  async verifyOrderInBinance(orderNo) {
    try {
      logger.info(`[${orderNo}] Liveness confirmed - verifying order on Binance...`);

      // ===== CONFIRM THE ORDER ON BINANCE =====
      // Now that liveness is genuinely complete (detected via chat signal), call
      // Binance to verify/confirm the additional-KYC for this order. This is the
      // action that marks the order verified on Binance's side.
      const verifyResult = await sellerBinanceService.verifyAdditionalKyc(orderNo);

      console.log(`[${orderNo}] verifyAdditionalKyc ->`, {
        success: verifyResult?.success,
        kycVerified: verifyResult?.kycVerified,
        code: verifyResult?.code,
        message: verifyResult?.message,
      });

      if (!verifyResult?.success) {
        // Binance rejected the verification - do NOT proceed to payment.
        logger.error(`[${orderNo}] ❌ Binance order verification failed`, {
          code: verifyResult?.code,
          message: verifyResult?.message,
        });
        await sellerOrderDbService.recordOrderVerified(orderNo, false, verifyResult?.message || 'verify failed');
        await sellerOrderDbService.recordError(orderNo, `Binance verify failed: ${verifyResult?.message || 'unknown'}`);
        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.REJECTED);
        return;
      }

      logger.info(`[${orderNo}] ✅ Order VERIFIED on Binance (kycVerified=${verifyResult.kycVerified})`);

      // Mark order as verified in our database
      await sellerOrderDbService.recordOrderVerified(orderNo, true);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFIED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFIED);

      // Method 1 ONLY: tell the buyer the order is verified and they can pay.
      // (Method 3 sends its own payment link/QR; Method 2 keeps its current flow.)
      // We detect "Method 1 only" as: not Method 3 and not Method 2 for this ad.
      try {
        const vOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
        const vAdNo = vOrder?.ad_no || this.stateManager.get(orderNo)?.adNo;
        const vRules = vAdNo ? await sellerOrderDbService.getAdRules(vAdNo) : null;
        const isMethod1Only = !vRules?.method3_full_enabled && !vRules?.method2_documents_enabled;
        if (isMethod1Only) {
          await this._sendChat({
            orderNo,
            content: await sellerMessageService.get(
              'seller_m1_order_verified',
              {},
              'Your order is verified. You can pay now.'
            ),
          });
        }
      } catch (msgErr) {
        logger.warn(`[${orderNo}] Method 1 verified-message step failed: ${msgErr.message}`);
      }

      // ===== STEP 5: PAYMENT HANDLING =====
      // For Method 1: Binance handles payment automatically
      await this.handlePayment(orderNo);

    } catch (error) {
      logger.error(`Order verify error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.REJECTED);
    }
  }

  /**
   * ===== STEP 5: PAYMENT HANDLING =====
   * Method 1/2: Binance automatic payment
   * Method 3: Payment gateway with tracking
   */
  async handlePayment(orderNo) {
    try {
      // Read adNo/adRules from the DB — the in-memory state manager is empty after
      // a restart, which would break the Method 3 branch.
      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const adNo = dbOrder?.ad_no || this.stateManager.get(orderNo)?.adNo;
      const adRules = adNo ? await sellerOrderDbService.getAdRules(adNo) : null;

      // ===== METHOD 3: PAYMENT GATEWAY =====
      if (adRules?.method3_full_enabled) {
        logger.info(`[${orderNo}] Method 3 — starting payment gateway flow`);
        await this.startMethod3Payment(orderNo, adRules);
        return;
      }

      // ===== METHOD 1/2: BINANCE AUTOMATIC =====
      logger.info(`[${orderNo}] Waiting for Binance payment (auto)...`);
      await this.waitForBinancePayment(orderNo);

    } catch (error) {
      logger.error(`Payment handling error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * METHOD 1/2: Wait for Binance payment
   * Poll order status to detect when payment is completed
   */
  async waitForBinancePayment(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);

      logger.info(`[${orderNo}] Waiting for buyer to complete payment on Binance...`);

      // Start polling order status to detect payment completion
      let previousOrderStatus = null;

      const paymentPollInterval = setInterval(async () => {
        try {
          const orderStatus = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);

          if (!orderStatus?.success) return;

          // First poll - record initial status
          if (previousOrderStatus === null) {
            previousOrderStatus = orderStatus.orderStatus;
            logger.debug(`[${orderNo}] Initial orderStatus: ${previousOrderStatus}`);
            return;
          }

          // Check order status:
          // 1 = WAIT_PAYMENT (buyer hasn't paid)
          // 2 = WAIT_RELEASE (buyer paid, seller needs to release)
          // 4 = COMPLETED (both paid and released)

          logger.debug(`[${orderNo}] Polling payment status: ${orderStatus.orderStatus}`);

          if (orderStatus.orderStatus === 2) {
            // ✅ BUYER PAID - Seller needs to release
            logger.info(`[${orderNo}] 💰 Buyer paid! orderStatus = 2 (WAIT_RELEASE)`);
            logger.info(`[${orderNo}] Waiting for seller to release crypto...`);

            // Continue polling for release
            previousOrderStatus = 2;
          } else if (orderStatus.orderStatus === 4) {
            // ✅ PAYMENT COMPLETE - Both paid and released
            logger.info(`[${orderNo}] ✅ Payment completed! orderStatus = 4 (COMPLETED)`);

            // Stop polling
            clearInterval(paymentPollInterval);
            if (this.paymentTimers[orderNo]) {
              clearTimeout(this.paymentTimers[orderNo]);
              delete this.paymentTimers[orderNo];
            }

            // Send thank you message
            await this.onBinancePaymentCompleted(orderNo);
          }

        } catch (error) {
          logger.error(`[${orderNo}] Payment polling error: ${error.message}`);
        }
      }, 5000); // Poll every 5 seconds

      this.paymentTimers[orderNo] = paymentPollInterval;

      // Set timeout (30 minutes) in case polling hangs
      const paymentTimeout = setTimeout(async () => {
        logger.warn(`[${orderNo}] Payment timeout! (30 minutes)`);

        // Stop polling
        if (this.paymentTimers[orderNo]) {
          clearInterval(this.paymentTimers[orderNo]);
          delete this.paymentTimers[orderNo];
        }

        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT);

        logger.info(`[${orderNo}] Order moved to timeout state. Manual intervention may be needed.`);
      }, 1800000); // 30 minutes

      this.paymentTimers[orderNo + '_timeout'] = paymentTimeout;

    } catch (error) {
      logger.error(`Binance payment wait error: ${error.message}`, { orderNo });
    }
  }

  /**
   * Called when Binance payment is completed
   */
  async onBinancePaymentCompleted(orderNo) {
    try {
      logger.info(`[${orderNo}] Binance payment completed!`);

      // Clear timeout
      if (this.paymentTimers[orderNo]) {
        clearTimeout(this.paymentTimers[orderNo]);
        delete this.paymentTimers[orderNo];
      }

      // ===== STEP 6: THANK YOU MESSAGE =====
      await this.sendThankYouMessage(orderNo);

    } catch (error) {
      logger.error(`Payment completion error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== METHOD 3: PAYMENT GATEWAY FLOW (Easebuzz) =====
   *
   * Runs after the order is verified (liveness + docs [+ OTP]). Steps:
   *   1. Tell the buyer the order is verified.
   *   2. Create a payment link/QR for the EXACT order fiat amount (Easebuzz).
   *   3. Send the link to the buyer in chat.
   *   4. Poll the gateway for payment success.
   *   5. On success: verify the payer name vs Binance KYC name where the gateway
   *      provides it (card payments). If it MISMATCHES → send the refund message,
   *      do NOT release. If it matches, or no payer name is available (UPI) → the
   *      buyer already passed liveness+docs[+OTP], so proceed to release.
   *   6. Release the crypto (checkIfCanReleaseCoin → releaseCoin). If Binance
   *      needs 2FA / fails → mark READY_TO_RELEASE and alert for manual release.
   */
  async startMethod3Payment(orderNo, adRules) {
    try {
      // Fall back to Easebuzz for any unconfigured/unsupported gateway (old ads
      // still carry 'razorpay', which isn't wired) so Method 3 never dead-ends.
      let gateway = (adRules.method3_payment_gateway || 'easebuzz').toLowerCase();

      // ===== EXPRESS UPI gateway =====
      // When the admin picks Express UPI, we do NOT send a payment link/QR — the
      // buyer pays through Binance's own Express UPI, and Binance reports the order
      // as paid (status 2). The bot just watches the order status; once the buyer
      // has paid, it auto-releases the crypto. No Easebuzz, no gateway polling.
      if (gateway === 'express_upi' || gateway === 'express' || gateway === 'expressupi') {
        logger.info(`[${orderNo}] Method 3: Express UPI — no payment link; watching Binance for payment then auto-release`);
        await this.startExpressUpiFlow(orderNo, adRules);
        return;
      }

      if (!paymentGatewayService.isSupported(gateway)) {
        logger.warn(`[${orderNo}] Method 3: gateway '${gateway}' not supported — falling back to easebuzz`);
        gateway = 'easebuzz';
      }

      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const amount = Number(dbOrder?.fiat_amount || dbOrder?.total_price || 0);
      const fiat = dbOrder?.fiat_unit || 'INR';
      const kycName = dbOrder?.buyer_kyc_name && dbOrder.buyer_kyc_name !== '(Unknown)'
        ? dbOrder.buyer_kyc_name : 'Customer';
      const phone = dbOrder?.mobile_number || null; // from OTP step if present

      if (!amount || amount <= 0) {
        logger.error(`[${orderNo}] Method 3: order amount unavailable — cannot create payment`);
        await sellerOrderDbService.recordError(orderNo, 'Method 3: order amount unavailable');
        return;
      }

      // 1) Order verified message
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get(
          'seller_m3_order_verified_pay',
          { amount, fiat },
          `Your order is verified. Please complete the payment of ${amount} ${fiat} using the link below.`
        ),
      });

      // 2) Create the payment link
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_LINK_SENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.PAYMENT_LINK_SENT);

      const linkRes = await paymentGatewayService.createLink(gateway, {
        orderNo, amount, name: kycName, phone,
      });

      if (!linkRes.success || !linkRes.link) {
        logger.error(`[${orderNo}] Method 3: link creation failed`, { detail: linkRes.message });
        await this._sendChat({
          orderNo,
          content: await sellerMessageService.get('seller_m3_link_failed', {},
            'We could not generate the payment link right now. Please wait a moment or contact support.'),
        });
        await sellerOrderDbService.recordError(orderNo, `Payment link failed: ${linkRes.message || 'unknown'}`);
        return;
      }

      await sellerOrderDbService.savePaymentLink(orderNo, {
        gateway, link: linkRes.link, merchantTxn: linkRes.merchantTxn, amount,
      });

      // 3) Send the link to the buyer
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get(
          'seller_m3_payment_link',
          { link: linkRes.link, amount, fiat },
          `Pay ${amount} ${fiat} here: ${linkRes.link}`
        ),
      });

      // 3b) Also send a scannable QR of the same link. Easebuzz doesn't return a QR
      // and Binance chat shows images only by URL, so we render the link into a PNG
      // ourselves and send its public URL. Best-effort: if QR fails, the link above
      // still works, so we never block the payment on it.
      try {
        const qrRes = await qrService.generatePaymentQr(linkRes.link, orderNo);
        if (qrRes.success && qrRes.url) {
          await this._sendChat({
            orderNo,
            content: await sellerMessageService.get(
              'seller_m3_payment_qr',
              { qr: qrRes.url, amount, fiat },
              `Or scan this QR to pay ${amount} ${fiat}: ${qrRes.url}`
            ),
          });
        } else {
          logger.warn(`[${orderNo}] Payment QR not sent: ${qrRes.message || 'unknown'}`);
        }
      } catch (qrErr) {
        logger.warn(`[${orderNo}] Payment QR step failed (link still sent): ${qrErr.message}`);
      }

      // 4) Poll the gateway for payment
      await this.pollGatewayPayment(orderNo, gateway, linkRes.merchantTxn, kycName);

    } catch (error) {
      logger.error(`Method 3 payment start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== METHOD 3: EXPRESS UPI FLOW =====
   * No payment link/QR. The buyer pays through Binance's own Express UPI, so
   * Binance moves the order to status 2 (WAIT_RELEASE) once they've paid. We poll
   * the order status; the moment it reads "paid", we auto-release the crypto
   * (checkIfCanReleaseCoin → releaseCoin via fund password). Binance itself owns the
   * payment verification and name match for Express UPI, so the bot's job is simply:
   * detect paid → release.
   */
  async startExpressUpiFlow(orderNo, adRules = {}) {
    try {
      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      const amount = Number(dbOrder?.fiat_amount || dbOrder?.total_price || 0) || undefined;
      const fiat = dbOrder?.fiat_unit || 'INR';
      const kycName = dbOrder?.buyer_kyc_name && dbOrder.buyer_kyc_name !== '(Unknown)'
        ? dbOrder.buyer_kyc_name : 'Customer';
      const phone = dbOrder?.mobile_number || null;

      // Admin chose whether to give the buyer a QR image, a payment link, or both.
      const wantQr = adRules.method3_express_qr_enabled === 1 || adRules.method3_express_qr_enabled === true;
      const wantLink = adRules.method3_express_link_enabled === 1 || adRules.method3_express_link_enabled === true;

      // Intro message (editable template).
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get(
          'seller_m3_express_upi_pay',
          { amount: amount || '', fiat },
          'Your order is verified. Please complete the payment shown on your Binance order screen. Your crypto will be released automatically once payment is confirmed.'
        ),
      });

      // Upload the one-time payment detail (Easebuzz QR/link) INTO the order so
      // Binance shows it on the buyer's Express UPI screen (fixes "Payment details
      // not ready"). Per Binance's p2plus doc: uploadOrderPaymentMethod.
      // SELLER_EXPRESS_SKIP_UPLOAD=true leaves the order un-uploaded (only 1 upload
      // allowed per order) so we can test the field format manually on a fresh order.
      if (String(process.env.SELLER_EXPRESS_SKIP_UPLOAD).toLowerCase() === 'true') {
        console.log(`\n⏭️  [${orderNo}] EXPRESS UPI: auto-upload SKIPPED (SELLER_EXPRESS_SKIP_UPLOAD=true)`);
      } else {
        try {
          await this.uploadExpressUpiPaymentDetail(orderNo, { amount, fiat, kycName, phone, wantQr, wantLink });
        } catch (upErr) {
          logger.error(`[${orderNo}] Express UPI upload failed: ${upErr.message}`);
        }
      }

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);

      if (this.gatewayPollers[orderNo]) return; // already watching
      let pollCount = 0;
      let busy = false;
      const INTERVAL = Number(process.env.SELLER_EXPRESS_POLL_INTERVAL) || 10000; // 10s
      const MAX_POLLS = Number(process.env.SELLER_EXPRESS_MAX_POLLS) || 8640;      // ~24h

      console.log(`\n🟢 [${orderNo}] EXPRESS UPI: watching Binance order status for payment...`);

      const poll = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          pollCount++;
          // Query across all states so we see 2 (paid), 4 (done), 6/7 (cancelled).
          const st = await sellerBinanceService.getOrderStatusAllStates(orderNo);
          if (!st?.success) { busy = false; return; }
          const status = Number(st.orderStatus);

          if (status === 2) {
            // ✅ Buyer paid via Express UPI → auto-release now.
            console.log(`🟢 [${orderNo}] EXPRESS UPI: buyer PAID (status 2) → auto-releasing`);
            logger.info(`[${orderNo}] Express UPI payment confirmed (status 2) — auto-releasing`);
            this._clearExpressPoller(orderNo);
            await sellerOrderDbService.recordPaymentReceived?.(orderNo);
            await this.releaseCryptoForOrder(orderNo);
            return;
          }
          if (status === 4) {
            // Already completed (Binance released it itself, e.g. Lightning-style).
            console.log(`🟢 [${orderNo}] EXPRESS UPI: order COMPLETED (status 4) — finalizing`);
            this._clearExpressPoller(orderNo);
            await this.finalizeCompletedOrder(orderNo);
            return;
          }
          if (status === 6 || status === 7) {
            console.log(`🟢 [${orderNo}] EXPRESS UPI: order CANCELLED (status ${status}) — stopping`);
            this._clearExpressPoller(orderNo);
            this.stateManager.setState(orderNo, SELLER_ORDER_STATES.CANCELLED);
            await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.CANCELLED, 'Express UPI: order cancelled');
            return;
          }

          if (pollCount >= MAX_POLLS) {
            console.log(`🟢 [${orderNo}] EXPRESS UPI: payment window ended (timeout)`);
            this._clearExpressPoller(orderNo);
          }
        } catch (e) {
          logger.warn(`[${orderNo}] Express UPI poll error: ${e.message}`);
        } finally {
          busy = false;
        }
      }, INTERVAL);

      this.gatewayPollers[orderNo] = poll;
    } catch (error) {
      logger.error(`[${orderNo}] startExpressUpiFlow error: ${error.message}`);
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Upload the one-time Express UPI payment detail into the order (fixes the
   * buyer's "Payment details not ready"). Uses the EASEBUZZ gateway (same as the
   * normal Method 3 flow) — so we get a real payment link + a QR of that link, plus
   * gateway payment tracking. Per Binance's p2plus doc:
   *   1. Easebuzz createLink → payment link (+ we render its QR)
   *   2. getTradeMethodDetail(identifier) → the upload field ids
   *   3. uploadOrderPaymentMethod(orderNo, identifier, [{id, fieldValue}])
   * Only done ONCE per order. `wantQr`/`wantLink` = admin's dashboard choice.
   * @returns {Promise<{merchantTxn:string|null}>} so the caller can poll the gateway.
   */
  async uploadExpressUpiPaymentDetail(orderNo, { amount, fiat, kycName, phone, wantQr, wantLink }) {
    // Which p2plus method is on this order?
    const detail = await sellerBinanceService.getOrderDetail(orderNo);
    const method = (detail?.raw?.payMethods || []).find(m => /p2plus|express/i.test(m.identifier || ''));
    const identifier = method?.identifier;
    if (!identifier) { logger.warn(`[${orderNo}] Express UPI: no p2plus method on order`); return { merchantTxn: null }; }

    // Easebuzz payment link (same as normal Method 3) + a QR image of that link.
    const linkRes = await paymentGatewayService.createLink('easebuzz', {
      orderNo, amount, name: kycName, phone,
    });
    if (!linkRes.success || !linkRes.link) {
      logger.error(`[${orderNo}] Express UPI: Easebuzz link creation failed`, { detail: linkRes.message });
      return { merchantTxn: null };
    }
    await sellerOrderDbService.savePaymentLink(orderNo, {
      gateway: 'easebuzz', link: linkRes.link, merchantTxn: linkRes.merchantTxn, amount,
    });
    let qrUrl = null;
    try {
      const qr = await qrService.generatePaymentQr(linkRes.link, orderNo);
      if (qr.success) qrUrl = qr.url;
    } catch (e) { /* QR optional */ }

    // Field ids for this method (which field.id is the QR-url / button).
    const md = await sellerBinanceService.getTradeMethodDetail(identifier);
    const qrField = (md.fields || []).find(f => f.fieldContentType === 'upload_qr_code_url');

    // Only ONE upload is allowed per order, so we send ONE fieldList. We use the QR
    // field (upload_qr_code_url) — verified working live (code 000000). It encodes
    // the Easebuzz payment link, so the buyer scans it to pay whether the admin
    // picked "QR" or "Link". (The button field's exact JSON format is unconfirmed;
    // mixing it in risks failing the whole upload, so we keep to the reliable QR.)
    const fieldList = [];
    if (qrField && qrUrl) {
      fieldList.push({ id: String(qrField.id), fieldValue: qrUrl });
    }
    if (!fieldList.length) {
      logger.warn(`[${orderNo}] Express UPI: no QR field/url to upload (qrField=${!!qrField} qrUrl=${!!qrUrl})`);
      return { merchantTxn: linkRes.merchantTxn };
    }

    console.log(`\n📤 [${orderNo}] EXPRESS UPI: uploading Easebuzz payment detail to order (${identifier}) fields=${fieldList.map(f => f.id).join(',')}`);
    const res = await sellerBinanceService.uploadOrderPaymentMethod(orderNo, identifier, fieldList);
    console.log(`   → success=${res.success} code=${res.code} msg=${res.message || ''}`);
    // -9000 "Payment method already uploaded" means a prior upload succeeded — a
    // buyer already has the payment detail. Only ONE upload is allowed per order,
    // so treat this as success (idempotent), not a failure.
    const alreadyUploaded = String(res.code) === '-9000' && /already uploaded/i.test(res.message || '');
    if (!res.success && !alreadyUploaded) {
      logger.error(`[${orderNo}] uploadOrderPaymentMethod failed`, { code: res.code, message: res.message, raw: res.raw });
    } else {
      logger.info(`[${orderNo}] ✅ Express UPI payment detail ${alreadyUploaded ? 'already present' : 'uploaded'} — buyer can now pay`);
    }
    return { merchantTxn: linkRes.merchantTxn };
  }

  /** Stop the Express UPI order-status poller. */
  _clearExpressPoller(orderNo) {
    if (this.gatewayPollers[orderNo]) {
      clearInterval(this.gatewayPollers[orderNo]);
      delete this.gatewayPollers[orderNo];
    }
  }

  /** Poll the payment gateway until the buyer pays (or the window ends). */
  async pollGatewayPayment(orderNo, gateway, merchantTxn, kycName) {
    if (this.gatewayPollers[orderNo]) return;

    this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);
    await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);

    let pollCount = 0;
    let busy = false;
    const INTERVAL = Number(process.env.SELLER_GATEWAY_POLL_INTERVAL) || 10000; // 10s
    const MAX_POLLS = Number(process.env.SELLER_GATEWAY_MAX_POLLS) || 360;       // ~1h at 10s

    const poll = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        pollCount++;
        const st = await paymentGatewayService.getStatus(gateway, merchantTxn);
        if (!st.success) { if (pollCount % 12 === 0) logger.debug(`[${orderNo}] gateway status err: ${st.message}`); return; }

        if (st.paid) {
          logger.info(`[${orderNo}] 💰 Payment received (${gateway})`, { easepayid: st.easepayid, mode: st.mode, payer: st.payerName });
          this.stopGatewayPolling(orderNo);
          await sellerOrderDbService.recordPaymentConfirmed(orderNo, {
            status: st.status, easepayid: st.easepayid, payerName: st.payerName, mode: st.mode,
          });
          await this._sendChat({
            orderNo,
            content: await sellerMessageService.get('seller_m3_payment_received', {},
              'Payment received. Verifying your payment, please wait...'),
          });
          await this.verifyPaymentAndRelease(orderNo, kycName, st.payerName);
          return;
        }

        if (pollCount >= MAX_POLLS) {
          logger.info(`[${orderNo}] Method 3 payment window ended (timeout)`);
          this.stopGatewayPolling(orderNo);
          this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT);
          await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT, 'gateway payment timeout');
        }
      } catch (err) {
        logger.error(`[${orderNo}] gateway poll error: ${err.message}`);
      } finally {
        busy = false;
      }
    }, INTERVAL);

    this.gatewayPollers[orderNo] = poll;
  }

  stopGatewayPolling(orderNo) {
    if (this.gatewayPollers[orderNo]) {
      clearInterval(this.gatewayPollers[orderNo]);
      delete this.gatewayPollers[orderNo];
    }
  }

  /**
   * Payment confirmed → decide whether to release the crypto.
   * - payerName present + MISMATCH → refund message, no release.
   * - payerName present + match, OR payerName absent (UPI) → release
   *   (buyer already passed liveness + documents [+ OTP]).
   */
  async verifyPaymentAndRelease(orderNo, kycName, payerName) {
    try {
      console.log(`\n💳 [${orderNo}] Method 3 payment verify:`);
      console.log(`    Binance KYC name : ${kycName}`);
      console.log(`    Gateway payer    : ${payerName || '(none — likely UPI)'}`);

      if (payerName && kycName && kycName !== 'Customer') {
        const m = matchNames(kycName, payerName);
        console.log(`    name match       : ${m.matched ? '✅ MATCH' : '❌ MISMATCH'}`);
        if (!m.matched) {
          logger.warn(`[${orderNo}] Method 3: payer name mismatch — NOT releasing`, { kycName, payerName });
          await this._sendChat({
            orderNo,
            content: await sellerMessageService.get('seller_m3_name_mismatch_refund', { kycName, payerName },
              'Your Binance KYC name and the bank account holder name did not match. Your amount will be refunded within 48 hours. Kindly cancel the order.'),
          });
          this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
          await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.REJECTED, 'Method 3: payer name mismatch');
          return;
        }
        logger.info(`[${orderNo}] Method 3: payer name matched KYC`, { kycName, payerName });
      } else {
        console.log(`    decision         : no gateway payer name → release on prior verification (liveness+docs${''})`);
        logger.info(`[${orderNo}] Method 3: no payer name from gateway (likely UPI) — proceeding on prior verification`);
      }

      console.log(`    → releasing crypto...`);
      await this.releaseCryptoForOrder(orderNo);
    } catch (error) {
      logger.error(`[${orderNo}] verifyPaymentAndRelease error: ${error.message}`);
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Release the crypto on Binance (checkIfCanReleaseCoin → releaseCoin). On any
   * failure (e.g. Binance requires a 2FA code) mark READY_TO_RELEASE for manual
   * release rather than forcing it.
   */
  async releaseCryptoForOrder(orderNo) {
    try {
      const hasFundPwd = !!process.env.SELLER_FUND_PASSWORD;
      console.log(`\n🔓 [${orderNo}] ===== AUTO-RELEASE START =====`);
      console.log(`    Fund password configured : ${hasFundPwd ? 'YES (FUND_PWD auto-release)' : 'NO (will fall back to manual)'}`);

      // Step A: is release allowed yet?
      console.log(`    Step 1: checkIfCanReleaseCoin ...`);
      const check = await sellerBinanceService.checkIfCanReleaseCoin(orderNo);
      console.log(`      → success=${check.success} canRelease=${check.canRelease} code=${check.code} msg=${check.message || ''}`);
      if (!check.success || !check.canRelease) {
        console.log(`      ⚠️  Not releasable yet → falling back to manual release watch`);
        logger.warn(`[${orderNo}] Cannot release yet (canRelease=${check.canRelease}) — waiting for manual release`);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT, 'ready to release — manual (checkIfCanReleaseCoin=false)');
        this.pollForManualRelease(orderNo); // cooldown starts only after real release
        return;
      }

      // Resolve payId + confirmPaidType for the FUND_PWD release. payId comes from
      // the order detail; confirmPaidType is 'normal' when the buyer has already
      // paid (order status 2), 'quick' when still pending (status 1).
      let payId = null;
      let confirmPaidType = 'normal';
      try {
        const detail = await sellerBinanceService.getOrderDetail(orderNo);
        const d = detail?.raw || {};
        // selectedPayId is the real payment-method id (e.g. 73161742). Prefer it —
        // d.payId is often 0 for UPI, and `??` would wrongly keep that 0. Fall back
        // to payMethods[0].id, then any non-zero payId.
        const firstMethodId = Array.isArray(d.payMethods) && d.payMethods[0] ? d.payMethods[0].id : null;
        payId = pickPayId(d.selectedPayId, firstMethodId, d.payMethodId, d.payId);
        const status = Number(detail?.orderStatus ?? d.orderStatus);
        // Per Binance's doc: confirmPaidType 'normal' = order status 2 (buyer paid),
        // 'quick' = order status 1 (pending buyer payment on Binance). Our gateway
        // already collected the money, but the buyer may not have pressed "Mark as
        // Paid" on Binance, so the order can still be status 1 → quick.
        confirmPaidType = (status === 1) ? 'quick' : 'normal';
        console.log(`    payId=${payId != null ? payId : '(none)'} | orderStatus=${status || '?'} → confirmPaidType=${confirmPaidType}`);
      } catch (dErr) {
        console.log(`    (order detail lookup failed: ${dErr.message} — releasing without payId)`);
      }

      // Step B: release the crypto (FUND_PWD method).
      console.log(`    Step 2: releaseCoin (FUND_PWD) ...`);
      const rel = await sellerBinanceService.releaseCoin(orderNo, { payId, confirmPaidType });
      console.log(`      → success=${rel.success} code=${rel.code} msg=${rel.message || ''}`);
      console.log(`      → raw: ${JSON.stringify(rel.raw)}`);
      if (!rel.success) {
        // Auto-release failed (e.g. Binance requires 2FA on this account). The
        // seller will release manually on Binance — watch for it so we mark the
        // order completed (and start the re-order cooldown) only once the crypto
        // is ACTUALLY released, not on payment-received.
        console.log(`      ❌ releaseCoin FAILED (code=${rel.code}) → seller must release manually`);
        logger.error(`[${orderNo}] releaseCoin failed — seller must release manually`, { code: rel.code, message: rel.message });
        await sellerOrderDbService.recordError(orderNo, `releaseCoin failed: ${rel.message || rel.code}`);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT, 'ready to release — manual (releaseCoin failed)');
        this.pollForManualRelease(orderNo);
        return;
      }

      console.log(`    ✅ [${orderNo}] CRYPTO AUTO-RELEASED SUCCESSFULLY (FUND_PWD)`);
      console.log(`🔓 [${orderNo}] ===== AUTO-RELEASE DONE =====\n`);
      logger.info(`[${orderNo}] ✅ Crypto released`);
      await sellerOrderDbService.recordCryptoReleased(orderNo);
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get('seller_m3_released', {},
          'Payment verified successfully. Your crypto has been released. Thank you for trading with us!'),
      });
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.COMPLETED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.COMPLETED);
    } catch (error) {
      console.log(`    ❌ [${orderNo}] releaseCryptoForOrder EXCEPTION: ${error.message}`);
      logger.error(`[${orderNo}] releaseCryptoForOrder error: ${error.message}`);
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Method 3: the bot couldn't auto-release (Binance requires 2FA), so the SELLER
   * releases the crypto manually on Binance. Poll the order status until Binance
   * reports it COMPLETED (status 4 = paid + released), then mark our order
   * completed and record crypto_released_at — this is what actually starts the
   * re-order cooldown (NOT payment-received). Idempotent; survives restarts since
   * the poller re-checks the DB state.
   */
  pollForManualRelease(orderNo) {
    if (this.paymentTimers[`m3rel_${orderNo}`]) return; // already watching

    let count = 0;
    const INTERVAL = Number(process.env.SELLER_RELEASE_POLL_INTERVAL) || 15000; // 15s
    const MAX = Number(process.env.SELLER_RELEASE_MAX_POLLS) || 5760;           // ~24h at 15s

    const timer = setInterval(async () => {
      count++;
      try {
        const st = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
        if (st?.success && st.orderStatus === 4) {
          // Seller released → order truly complete.
          logger.info(`[${orderNo}] ✅ Manual release detected (Binance status 4) — marking completed`);
          clearInterval(timer);
          delete this.paymentTimers[`m3rel_${orderNo}`];
          await sellerOrderDbService.recordCryptoReleased(orderNo);
          this.stateManager.setState(orderNo, SELLER_ORDER_STATES.COMPLETED);
          await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.COMPLETED, 'Seller released crypto manually');
          return;
        }
        // Order cancelled/appealed → stop watching (no cooldown).
        if (st?.success && (st.orderStatus === 6 || st.orderStatus === 7)) {
          logger.info(`[${orderNo}] Manual-release watch: order cancelled (status ${st.orderStatus}) — stop watching`);
          clearInterval(timer);
          delete this.paymentTimers[`m3rel_${orderNo}`];
          return;
        }
        if (count >= MAX) {
          clearInterval(timer);
          delete this.paymentTimers[`m3rel_${orderNo}`];
          logger.warn(`[${orderNo}] Manual-release watch timed out after ~24h`);
        }
      } catch (e) {
        logger.debug(`[${orderNo}] manual-release poll error: ${e.message}`);
      }
    }, INTERVAL);

    this.paymentTimers[`m3rel_${orderNo}`] = timer;
    logger.info(`[${orderNo}] ⏳ Watching for seller's manual release (cooldown starts after release)`);
  }

  /**
   * Called when payment webhook is received
   */
  async onPaymentWebhookReceived(orderNo, webhookData) {
    try {
      logger.info(`[${orderNo}] Payment webhook received!`, {
        status: webhookData.status,
        utr: webhookData.utr
      });

      // Clear timeout
      if (this.paymentTimers[orderNo]) {
        clearTimeout(this.paymentTimers[orderNo]);
        delete this.paymentTimers[orderNo];
      }

      // Record payment
      await sellerOrderDbService.recordPaymentReceived(
        orderNo,
        webhookData.utr,
        webhookData.amount
      );

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_RECEIVED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.PAYMENT_RECEIVED);

      // ===== STEP 6: THANK YOU MESSAGE =====
      await this.sendThankYouMessage(orderNo);

    } catch (error) {
      logger.error(`Payment webhook error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== STEP 6: SEND THANK YOU MESSAGE =====
   * Final step before order completion
   */
  /**
   * Finalise a trade that Binance reports COMPLETED (status 4). Idempotent — the
   * poller may call it repeatedly. Records the release time (which STARTS the
   * re-order cooldown), sends the thank-you once, and marks the order COMPLETED.
   */
  async finalizeCompletedOrder(orderNo) {
    // In-memory guard so two overlapping poll cycles can't double-finalise.
    if (!this._finalizing) this._finalizing = new Set();
    if (this._finalizing.has(orderNo)) return;
    this._finalizing.add(orderNo);
    try {
      const dbOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (!dbOrder) return;
      if (dbOrder.current_state === SELLER_ORDER_STATES.COMPLETED) return; // already done

      // Stop any in-flight loops for this order.
      this.stopMethod2Verification?.(orderNo);
      this.stopOtpVerification?.(orderNo);
      this.stopGatewayPolling?.(orderNo);

      // Record the release/completion time (cooldown keys off crypto_released_at).
      if (!dbOrder.crypto_released_at) {
        await sellerOrderDbService.recordCryptoReleased(orderNo);
      }
      // Send thank-you only once.
      if (!dbOrder.thank_you_message_sent_at) {
        await this.sendThankYouMessage(orderNo);
      } else {
        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.COMPLETED);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.COMPLETED);
      }
    } catch (error) {
      logger.error(`[${orderNo}] finalizeCompletedOrder error: ${error.message}`);
    } finally {
      this._finalizing.delete(orderNo);
    }
  }

  async sendThankYouMessage(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.SENDING_THANK_YOU);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.SENDING_THANK_YOU);

      logger.info(`[${orderNo}] Sending thank you message...`);

      // Send thank you
      await this._sendChat({
        orderNo,
        content: await sellerMessageService.get(
          'seller_thank_you',
          {},
          'Payment completed! ✓\n\nThank you for trading with us! Your crypto will be released shortly.'
        ),
        msgType: 'TEXT'
      });

      await sellerOrderDbService.recordThankYouMessageSent(orderNo);

      // Mark as completed
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.COMPLETED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.COMPLETED);

      logger.info(`[${orderNo}] ✅ Order completed!`);

      // Remove from state manager after short delay
      setTimeout(() => {
        this.stateManager.remove(orderNo);
      }, 5000);

    } catch (error) {
      logger.error(`Thank you message error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== CALLBACK: Payment Webhook Received (Method 3) =====
   * Called when payment webhook is received from Razorpay/Paywize
   */
  async onPaymentWebhookReceived(orderNo) {
    try {
      logger.info(`[${orderNo}] Payment webhook received, proceeding to thank you...`);

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (!order) {
        logger.warn(`[${orderNo}] Order not found for webhook callback`);
        return;
      }

      // Send thank you message
      await this.sendThankYouMessage(orderNo);

    } catch (error) {
      logger.error(`Payment webhook callback error: ${error.message}`, { orderNo });
    }
  }
}

module.exports = {
  SellerOrderHandler
};
