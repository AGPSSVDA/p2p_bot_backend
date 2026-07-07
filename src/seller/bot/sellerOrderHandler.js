const logger = require('../../utils/logger');
const { chatService } = require('../../services/chatService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerAdService = require('../services/sellerAdService');
const sellerEligibilityService = require('../services/sellerEligibilityService');
const sellerBuyerMetricsService = require('../services/sellerBuyerMetricsService');
const { SellerStateManager, SELLER_ORDER_STATES } = require('./sellerStateManager');
const sellerVerificationService = require('../services/sellerVerificationService');
const { binanceService } = require('../../services/binanceService');

class SellerOrderHandler {
  constructor() {
    this.stateManager = new SellerStateManager();
    this.livenessTimers = {};
    this.documentTimers = {};
    this.otpTimers = {};
    this.paymentTimers = {};
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
        ad: ad.ad_no
      });

      // Add to state manager
      this.stateManager.add({
        orderNumber: orderNo,
        sellerId: ad.seller_id,
        buyerId: rawOrder.counterPartUserId,
        buyerNickname: rawOrder.counterPartNickName,
        buyerKycName: rawOrder.userFullName || '(Unknown)',
        adNo: ad.ad_no,
        cryptoAmount: rawOrder.amount,
        fiatAmount: rawOrder.totalPrice
      });

      // Persist to database
      await sellerOrderDbService.upsertOrder({
        orderNumber: orderNo,
        sellerId: ad.seller_id,
        buyerId: rawOrder.counterPartUserId,
        buyerNickname: rawOrder.counterPartNickName,
        buyerKycName: rawOrder.userFullName,
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

      // ===== STEP 2: ELIGIBILITY CHECK =====
      // Pass both adRules and ad.ad_no to eligibility check
      await this.performEligibilityCheck(orderNo, rawOrder.counterPartUserId, ad.ad_no, adRules);

    } catch (error) {
      logger.error(`Order handler error: ${error.message}`, { orderNo, error });
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.REJECTED);
    }
  }

  /**
   * ===== STEP 2: ELIGIBILITY CHECK =====
   */
  async performEligibilityCheck(orderNo, buyerId, adNo, adRules) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.CHECKING_ELIGIBILITY);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.CHECKING_ELIGIBILITY);

      logger.info(`[${orderNo}] Checking buyer eligibility...`);

      // Check buyer against ad rules
      const eligibility = await sellerEligibilityService.checkBuyerEligibility(
        buyerId,
        adNo
      );

      // Record result
      await sellerOrderDbService.recordEligibilityCheck(
        orderNo,
        eligibility.eligible,
        eligibility.eligible ? null : eligibility.reason
      );

      if (!eligibility.eligible) {
        logger.warn(`[${orderNo}] Buyer ineligible`, { reason: eligibility.reason });

        // Send message to buyer
        const message = sellerEligibilityService.formatEligibilityMessage(
          eligibility.failedChecks
        );
        await chatService.sendMessage({
          orderNo,
          content: message,
          msgType: 'TEXT'
        });

        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.ELIGIBILITY_FAILED);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.ELIGIBILITY_FAILED);
        return;
      }

      logger.info(`[${orderNo}] ✅ Buyer eligible, proceeding to verification`);

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.ELIGIBILITY_PASSED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.ELIGIBILITY_PASSED);

      // ===== STEP 3: START VERIFICATION =====
      await this.startVerification(orderNo, adRules);

    } catch (error) {
      logger.error(`Eligibility check error: ${error.message}`, { orderNo });
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * ===== STEP 3: START VERIFICATION (Methods 1, 2, or 3) =====
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

      // Start liveness timeout (10 minutes)
      this.startLivenessTimeout(orderNo);

    } catch (error) {
      logger.error(`Liveness verification error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
    }
  }

  /**
   * Called when liveness check completes (detected via polling)
   */
  async onLivenessCompleted(orderNo) {
    try {
      logger.info(`[${orderNo}] Liveness check completed!`);

      // Clear timeout
      if (this.livenessTimers[orderNo]) {
        clearTimeout(this.livenessTimers[orderNo]);
        delete this.livenessTimers[orderNo];
      }

      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.LIVENESS_COMPLETED);
      await sellerOrderDbService.recordLivenessCompleted(orderNo, true);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.LIVENESS_COMPLETED);

      // ===== STEP 4: ORDER VERIFICATION IN BINANCE =====
      await this.verifyOrderInBinance(orderNo);

    } catch (error) {
      logger.error(`Liveness completion error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
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
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.VERIFYING_ORDER);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.VERIFYING_ORDER);
      await sellerOrderDbService.recordOrderVerifyAttempted(orderNo);

      logger.info(`[${orderNo}] Calling Binance verifyOrder API...`);

      // Call Binance API to verify order
      const verifyResult = await binanceService.verifyOrder(orderNo);

      if (!verifyResult.success) {
        logger.error(`[${orderNo}] Binance verification failed`, {
          error: verifyResult.error
        });

        await sellerOrderDbService.recordOrderVerified(orderNo, false, verifyResult.error);
        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFY_FAILED);
        await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFY_FAILED);
        return;
      }

      logger.info(`[${orderNo}] ✅ Order verified in Binance!`);

      await sellerOrderDbService.recordOrderVerified(orderNo, true);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFIED);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.ORDER_VERIFIED);

      // ===== STEP 5: PAYMENT HANDLING =====
      await this.handlePayment(orderNo);

    } catch (error) {
      logger.error(`Order verify error: ${error.message}`, { orderNo });
      await sellerOrderDbService.recordError(orderNo, error.message);
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.REJECTED);
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
   */
  async waitForBinancePayment(orderNo) {
    try {
      this.stateManager.setState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);
      await sellerOrderDbService.setOrderState(orderNo, SELLER_ORDER_STATES.WAITING_PAYMENT);

      logger.info(`[${orderNo}] Waiting for buyer to complete payment on Binance...`);

      // Poll order status until payment complete
      // When complete: GOTO Step 6 (Thank you message)

      // For now, set timeout and wait
      const paymentTimeout = setTimeout(async () => {
        logger.warn(`[${orderNo}] Payment timeout!`);
        this.stateManager.setState(orderNo, SELLER_ORDER_STATES.PAYMENT_TIMEOUT);
        delete this.paymentTimers[orderNo];
      }, 1800000); // 30 minutes

      this.paymentTimers[orderNo] = paymentTimeout;

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
  SellerOrderHandler: new SellerOrderHandler()
};
