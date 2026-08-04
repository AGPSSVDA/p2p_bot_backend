const logger = require('../../utils/logger');
const { chatService } = require('../../services/chatService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerAdService = require('../services/sellerAdService');
const sellerEligibilityService = require('../services/sellerEligibilityService');
const sellerBuyerMetricsService = require('../services/sellerBuyerMetricsService');
const { SellerStateManager, SELLER_ORDER_STATES } = require('./sellerStateManager');
const sellerVerificationService = require('../services/sellerVerificationService');
// Seller flows use the SELLER API key only (sellerBinanceService).
const sellerBinanceService = require('../services/sellerBinanceService');
const sellerMethod2Service = require('../services/sellerMethod2Service');

class SellerOrderHandler {
  constructor() {
    this.stateManager = new SellerStateManager();
    this.livenessTimers = {};
    this.documentTimers = {};
    this.otpTimers = {};
    this.paymentTimers = {};
    this.livenessPollers = {}; // Polling intervals for liveness check
    this.documentPollers = {}; // Polling intervals for Method 2 chat image collection
  }

  /**
   * Immediately stop ALL in-flight work — every liveness/document/payment poll
   * loop and timer across every order. Used when the seller bot is stopped.
   */
  stopAll() {
    const stores = [
      this.livenessPollers,
      this.documentPollers,
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

      // ===== 24-HOUR COOLDOWN CHECK (before any verification) =====
      // If this buyer COMPLETED an order in the last 24h, they cannot place a new
      // one yet. Tell them in chat and stop — no liveness/method check runs.
      const recent = await sellerOrderDbService.getRecentCompletedOrderByBuyer(
        buyerId,
        orderNo,
        24
      );
      if (recent) {
        const completedAt = new Date(recent.completed_at);
        const nextAllowed = new Date(completedAt.getTime() + 24 * 60 * 60 * 1000);
        const hoursLeft = Math.max(
          1,
          Math.ceil((nextAllowed.getTime() - Date.now()) / (60 * 60 * 1000))
        );

        logger.info(`[${orderNo}] ⛔ 24h cooldown: buyer completed order ${recent.order_number} recently`, {
          buyerId,
          previousOrder: recent.order_number,
          completedAt: recent.completed_at,
          hoursLeft,
        });

        await chatService.sendMessage({
          orderNo,
          content:
            `You have already placed an order in the last 24 hours. ` +
            `Only one order per 24 hours is allowed. ` +
            `Please place a new order after ${hoursLeft} hour(s).`,
          msgType: 'TEXT',
        });

        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
        await sellerOrderDbService.setOrderState(
          orderNo,
          SELLER_ORDER_STATES.REJECTED,
          '24h cooldown: buyer completed a previous order within 24h'
        );
        await sellerOrderDbService.recordError(
          orderNo,
          `24h cooldown - previous order ${recent.order_number}`
        );
        return; // Do NOT proceed to liveness / any method
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
      await chatService.sendMessage({
        orderNo,
        content: 'Please complete the liveness check on Binance to proceed with your order.',
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
      const MAX_POLLS = 100; // ~5 minutes with 3-second interval

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

            clearInterval(this.livenessPollers[orderNo]);
            delete this.livenessPollers[orderNo];
            if (this.livenessTimers[orderNo]) {
              clearTimeout(this.livenessTimers[orderNo]);
              delete this.livenessTimers[orderNo];
            }

            await this.onLivenessCompleted(orderNo);
            return;
          }

          // ===== SECONDARY: honor additionalKycVerify if it happens to update =====
          // (0 = not required -> proceed; 2 = verified -> proceed). Best-effort.
          const orderStatus = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
          const kycStatus = orderStatus?.success ? orderStatus.additionalKycVerify : undefined;

          if (kycStatus === 0 || kycStatus === 2) {
            console.log(`[${orderNo}] ✅ Proceeding via additionalKycVerify=${kycStatus} (after ${pollCount} polls)`);
            logger.info(`[${orderNo}] Proceeding via additionalKycVerify=${kycStatus}`);

            clearInterval(this.livenessPollers[orderNo]);
            delete this.livenessPollers[orderNo];
            if (this.livenessTimers[orderNo]) {
              clearTimeout(this.livenessTimers[orderNo]);
              delete this.livenessTimers[orderNo];
            }

            await this.onLivenessCompleted(orderNo);
            return;
          }

          // Still pending
          if (pollCount % 10 === 0 || pollCount <= 3) {
            console.log(`[${orderNo}] ⏳ Poll #${pollCount}: Liveness still pending (no chat signal, additionalKycVerify=${kycStatus})`);
          }

          // Timeout
          if (pollCount >= MAX_POLLS) {
            console.log(`[${orderNo}] ⏱️  Timeout: Max polls (${MAX_POLLS}) reached - liveness not completed`);
            logger.warn(`[${orderNo}] Timeout: Liveness did not complete within ${MAX_POLLS} polls (~5 minutes)`);

            clearInterval(this.livenessPollers[orderNo]);
            delete this.livenessPollers[orderNo];

            this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);
            await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);

            await chatService.sendMessage({
              orderNo,
              content: 'Liveness check timeout. Your order has been cancelled. Please try again.',
              msgType: 'TEXT'
            });

            if (this.livenessTimers[orderNo]) {
              clearTimeout(this.livenessTimers[orderNo]);
              delete this.livenessTimers[orderNo];
            }
          }

        } catch (error) {
          logger.error(`[${orderNo}] Poll #${pollCount} - Error: ${error.message}`, { error });
          console.log(`[${orderNo}] Poll #${pollCount}: Error - ${error.message}, will retry...`);
        }
      }, 3000); // Poll every 3 seconds (balanced approach)

      this.livenessPollers[orderNo] = pollInterval;

      // Timeout as safety net (in case polling stops for some reason)
      const timeoutId = setTimeout(async () => {
        logger.warn(`[${orderNo}] Liveness timeout safety net triggered!`);

        if (this.livenessPollers[orderNo]) {
          clearInterval(this.livenessPollers[orderNo]);
          delete this.livenessPollers[orderNo];
        }

        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);

        await chatService.sendMessage({
          orderNo,
          content: 'Liveness check timeout. Your order has been cancelled. Please try again.',
          msgType: 'TEXT'
        });

        delete this.livenessTimers[orderNo];

      }, 600000); // 10 minutes safety net

      this.livenessTimers[orderNo] = timeoutId;

    } catch (error) {
      logger.error(`Liveness polling start error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
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

      if (adRules?.method2_documents_enabled) {
        logger.info(`[${orderNo}] Method 2 enabled - starting document verification`);
        await this.startMethod2Verification(orderNo);
        return; // Order is verified only after documents pass
      }

      // ===== STEP 4: ORDER VERIFICATION IN BINANCE =====
      await this.verifyOrderInBinance(orderNo);

    } catch (error) {
      logger.error(`Liveness completion error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== METHOD 2: DOCUMENT VERIFICATION =====
   *
   * Polls the order chat and, on each cycle, runs the full document-verification
   * flow (sellerMethod2Service):
   *   OpenAI classify+extract -> require Aadhaar front+back + PAN
   *   -> Aadhaar name ⟷ KYC name -> Surepass PAN verify -> PAN name ⟷ KYC name
   *   -> verify the order in Binance.
   *
   * Chat messages (missing docs, mismatch, PAN fail, limit exceeded) are sent to
   * the buyer, de-duplicated so the same message isn't repeated every 3 seconds.
   * The images are also stored for the record (idempotent).
   */
  async startMethod2Verification(orderNo) {
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

      // ---- Wait for 3 images before calling OpenAI ----
      // Method 2 requires 3 documents: Aadhaar front, Aadhaar back, PAN.
      // (PAN back is not required — it's blank/QR with nothing to verify.)
      // We only run the (expensive) OpenAI classification once the buyer has
      // uploaded 3+ images — and only re-run when the image count CHANGES
      // afterwards (e.g. re-upload after a mismatch), so we never classify a
      // half-set or waste tokens re-running the same set.
      const REQUIRED_IMAGES = Number(process.env.METHOD2_REQUIRED_IMAGES) || 3;
      let verifiedCount = -1;       // image count we last ran OpenAI on

      const sendOnce = async (content) => {
        if (!content || content === lastMessage) return;
        lastMessage = content;
        await chatService.sendMessage({ orderNo, content, msgType: 'TEXT' });
      };

      const pollInterval = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          pollCount++;

          // Fetch current images + store new ones for the record (idempotent).
          const imgs = await sellerBinanceService.getBuyerUploadedImages(orderNo);
          const images = imgs.success ? imgs.images : [];
          for (const image of images) {
            await sellerOrderDbService.saveChatImage(orderNo, buyerId, image);
          }

          const count = images.length;

          // Wait until at least REQUIRED_IMAGES (3) are uploaded.
          if (count < REQUIRED_IMAGES) {
            if (pollCount % 10 === 0) {
              logger.debug(`[${orderNo}] Method 2: waiting for images (${count}/${REQUIRED_IMAGES})`);
            }
            return;
          }

          // Only run OpenAI when this image set is new (count changed since the
          // last classification). Otherwise keep waiting for the next upload.
          if (count === verifiedCount) return;

          verifiedCount = count; // mark this set as classified
          logger.info(`[${orderNo}] 📄 ${count} images uploaded — running OpenAI classification`);

          // Run one verification pass on the full image set.
          const result = await sellerMethod2Service.runVerification(orderNo, kycName, images);

          switch (result.status) {
            case 'verified':
              logger.info(`[${orderNo}] ✅ Method 2 verified — proceeding to order verification`);
              this.stopMethod2Verification(orderNo);
              await sellerOrderDbService.recordDocumentVerified(orderNo, 'aadhaar', true);
              await sellerOrderDbService.recordDocumentVerified(orderNo, 'pan', true);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFIED);
              await this.verifyOrderInBinance(orderNo);
              break;

            case 'limit_exceeded':
              logger.warn(`[${orderNo}] Method 2 attempt limit exceeded`);
              this.stopMethod2Verification(orderNo);
              await sendOnce(result.message);
              this.stateManager.setState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED);
              await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.DOCUMENTS_VERIFICATION_FAILED, 'attempt limit exceeded');
              break;

            case 'need_upload':
            case 'name_mismatch':
            case 'pan_failed':
              // Ask the buyer (once) for what's needed; keep polling for re-uploads.
              if (result.message) await sendOnce(result.message);
              break;

            case 'error':
            default:
              if (pollCount % 20 === 0 || pollCount <= 2) {
                logger.debug(`[${orderNo}] Method 2 pass: ${result.status}`, { detail: result.detail });
              }
              break;
          }

          if (pollCount >= MAX_POLLS && this.documentPollers[orderNo]) {
            logger.info(`[${orderNo}] Method 2 verification window ended (timeout)`);
            this.stopMethod2Verification(orderNo);
            await sendOnce('Document verification timed out. You can cancel this order and try again.');
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
   * Liveness timeout handler
   */
  startLivenessTimeout(orderNo) {
    const timeout = setTimeout(async () => {
      logger.warn(`[${orderNo}] Liveness check timeout!`);

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_TIMEOUT);

      // Send message
      await chatService.sendMessage({
        orderNo,
        content: 'Liveness check timeout. Your order has been cancelled. Please try again.',
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
      await chatService.sendMessage({
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
        await chatService.sendMessage({
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
      await chatService.sendMessage({
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
        await chatService.sendMessage({
          orderNo,
          content: 'Failed to send OTP. Please try again.',
          msgType: 'TEXT'
        });
        return;
      }

      // Send message
      await chatService.sendMessage({
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
        await chatService.sendMessage({
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
      const order = this.stateManager.get(orderNo);
      const adRules = await sellerOrderDbService.getAdRules(order.adNo);

      // ===== METHOD 1/2: BINANCE AUTOMATIC =====
      if (!adRules.method3_full_enabled) {
        logger.info(`[${orderNo}] Waiting for Binance payment (auto)...`);

        // Wait for payment webhook from Binance
        // Or poll order status
        // Then send thank you message

        await this.waitForBinancePayment(orderNo);
        return;
      }

      // ===== METHOD 3: PAYMENT GATEWAY =====
      logger.info(`[${orderNo}] Sending payment link (Method 3)...`);

      await this.sendPaymentLink(orderNo, adRules);

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
   * METHOD 3: Send payment link
   */
  async sendPaymentLink(orderNo, adRules) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_LINK_SENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.PAYMENT_LINK_SENT);

      logger.info(`[${orderNo}] Generating payment link...`);

      // Generate payment link
      const linkResult = await sellerVerificationService.generatePaymentLink(
        orderNo,
        adRules.method3_payment_gateway,
        adRules.method3_delivery_method
      );

      if (!linkResult.success) {
        throw new Error(`Failed to generate payment link: ${linkResult.reason}`);
      }

      // Send to buyer
      const message = adRules.method3_delivery_method === 'qr_code'
        ? 'Please scan the QR code below to complete payment:'
        : 'Please click the link below to complete payment:';

      await chatService.sendMessage({
        orderNo,
        content: `${message}\n\n${linkResult.link || linkResult.qrCode}`,
        msgType: adRules.method3_delivery_method === 'qr_code' ? 'IMAGE' : 'TEXT'
      });

      await sellerOrderDbService.recordPaymentLinkSent(orderNo);

      // Start listening for payment webhook
      await this.waitForPaymentWebhook(orderNo);

    } catch (error) {
      logger.error(`Payment link error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * METHOD 3: Wait for payment webhook
   */
  async waitForPaymentWebhook(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);

      logger.info(`[${orderNo}] Waiting for payment webhook...`);

      // Set timeout
      const timeout = setTimeout(async () => {
        logger.warn(`[${orderNo}] Payment webhook timeout!`);
        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT);
        delete this.paymentTimers[orderNo];
      }, 86400000); // 24 hours

      this.paymentTimers[orderNo] = timeout;

    } catch (error) {
      logger.error(`Payment webhook wait error: ${error.message}`, { orderNo });
    }
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
  async sendThankYouMessage(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.SENDING_THANK_YOU);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.SENDING_THANK_YOU);

      logger.info(`[${orderNo}] Sending thank you message...`);

      // Send thank you
      await chatService.sendMessage({
        orderNo,
        content: 'Payment completed! ✓\n\nThank you for trading with us! Your crypto will be released shortly.',
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
