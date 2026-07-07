const logger = require('../../utils/logger');

/**
 * ===== SELLER MESSAGE TEMPLATES =====
 * All messages sent to buyer during order processing
 * Customizable from dashboard (in future phases)
 */
class SellerMessages {

  // ===== STEP 2: ELIGIBILITY CHECK =====

  ineligibleBuyerMessage(failureReasons) {
    return `❌ Unfortunately, you don't meet the seller's eligibility criteria:\n\n${failureReasons}\n\nPlease try another order or wait until you meet these criteria.`;
  }

  eligibilityPassedMessage() {
    return `✅ Great! You meet all the seller's eligibility criteria. Proceeding with verification...`;
  }

  // ===== STEP 3A: LIVENESS CHECK (METHOD 1) =====

  livenessCheckRequestMessage() {
    return `🔍 Please complete the liveness verification on Binance to proceed with your order.\n\n` +
           `The liveness check helps verify your identity and ensures secure trading.`;
  }

  livenessCheckTimeoutMessage() {
    return `⏰ The liveness check verification timed out.\n\n` +
           `Your order has been cancelled. Please try again with a new order.`;
  }

  livenessCheckCompletedMessage() {
    return `✅ Liveness verification completed! Proceeding to next step...`;
  }

  // ===== STEP 3B: DOCUMENT UPLOAD (METHOD 2 & 3) =====

  documentUploadRequestMessage() {
    return `📄 Please upload your documents for verification:\n\n` +
           `1. Upload your Aadhaar card (front side)\n` +
           `2. Upload your PAN card\n\n` +
           `Make sure the documents are clear and legible.`;
  }

  documentUploadTimeoutMessage() {
    return `⏰ Document upload timed out.\n\n` +
           `Your order has been cancelled. Please try again with a new order.`;
  }

  documentUploadReceiredMessage() {
    return `✅ Documents received! Verifying...`;
  }

  documentVerificationFailedMessage(reason) {
    return `❌ Document verification failed:\n\n${reason}\n\n` +
           `Please upload clear photos of your valid documents and try again.`;
  }

  documentVerificationSuccessMessage() {
    return `✅ Documents verified successfully!`;
  }

  // ===== STEP 3B OPTIONAL: MOBILE OTP VERIFICATION =====

  mobileOtpRequestMessage() {
    return `📱 Please provide your mobile number for OTP verification.\n\n` +
           `Reply with your 10-digit mobile number (e.g., 9876543210)`;
  }

  mobileOtpSentMessage(maskedNumber) {
    return `✅ OTP sent to your mobile number ending in ${maskedNumber}\n\n` +
           `Reply with the 4-6 digit OTP you received.`;
  }

  mobileOtpInvalidMessage() {
    return `❌ Invalid OTP. Please try again.`;
  }

  mobileOtpTimeoutMessage() {
    return `⏰ Mobile verification timed out.\n\nYour order has been cancelled.`;
  }

  mobileOtpVerifiedMessage() {
    return `✅ Mobile number verified successfully!`;
  }

  // ===== STEP 4: ORDER VERIFICATION =====

  orderVerifyingMessage() {
    return `⚙️ Verifying your order on Binance...`;
  }

  orderVerificationFailedMessage(error) {
    return `❌ Order verification failed:\n\n${error}\n\n` +
           `Please contact support if this issue persists.`;
  }

  orderVerifiedMessage() {
    return `✅ Order verified successfully!`;
  }

  // ===== STEP 5: PAYMENT (METHOD 1/2 - BINANCE AUTO) =====

  binancePaymentWaitingMessage() {
    return `⏳ Please complete the payment on Binance to proceed.\n\n` +
           `After you send the payment, we'll release your crypto immediately.`;
  }

  binancePaymentTimeoutMessage() {
    return `⏰ Payment timeout.\n\nYour order has been cancelled.`;
  }

  // ===== STEP 5: PAYMENT (METHOD 3 - PAYMENT LINK/QR) =====

  paymentLinkMessage(link) {
    return `💳 Please complete payment using the link below:\n\n` +
           `${link}\n\n` +
           `After payment is confirmed, your crypto will be released immediately.`;
  }

  paymentQrCodeMessage() {
    return `📱 Please scan the QR code below to complete payment:\n\n` +
           `[QR CODE IMAGE]\n\n` +
           `Or click the link in the next message.`;
  }

  paymentWaitingMessage() {
    return `⏳ Waiting for payment confirmation...`;
  }

  paymentTimeoutMessage() {
    return `⏰ Payment timeout.\n\nYour order has been cancelled.`;
  }

  // ===== STEP 6: THANK YOU & COMPLETION =====

  paymentReceivedMessage() {
    return `✅ Payment received! Thank you!\n\n` +
           `Your crypto is being released to your wallet.`;
  }

  orderCompletedMessage() {
    return `🎉 Order completed successfully!\n\n` +
           `✅ Payment received\n` +
           `✅ Crypto released\n\n` +
           `Thank you for trading with us! See you next time.`;
  }

  // ===== ERROR MESSAGES =====

  genericErrorMessage() {
    return `❌ An error occurred while processing your order.\n\n` +
           `Please contact support for assistance.`;
  }

  orderCancelledMessage(reason) {
    return `❌ Your order has been cancelled.\n\n` +
           `Reason: ${reason}\n\n` +
           `Feel free to place a new order.`;
  }

  // ===== HELPER: Format eligibility failures =====

  formatEligibilityFailures(failedChecks) {
    if (failedChecks.length === 0) return 'All criteria passed!';

    const formatted = failedChecks
      .map(check => `• ${check.criterion}: Required ${check.required}, You have ${check.actual}`)
      .join('\n');

    return formatted;
  }

  // ===== HELPER: Get all messages (for logging/debugging) =====

  getAllMessages() {
    return {
      // Step 2
      ineligible: this.ineligibleBuyerMessage('test'),
      eligibilityPassed: this.eligibilityPassedMessage(),

      // Step 3A
      livenessRequest: this.livenessCheckRequestMessage(),
      livenessTimeout: this.livenessCheckTimeoutMessage(),
      livenessCompleted: this.livenessCheckCompletedMessage(),

      // Step 3B
      documentRequest: this.documentUploadRequestMessage(),
      documentTimeout: this.documentUploadTimeoutMessage(),
      documentReceived: this.documentUploadReceiredMessage(),
      documentFailed: this.documentVerificationFailedMessage('test'),
      documentSuccess: this.documentVerificationSuccessMessage(),

      // Step 3B Optional
      otpRequest: this.mobileOtpRequestMessage(),
      otpSent: this.mobileOtpSentMessage('1234'),
      otpInvalid: this.mobileOtpInvalidMessage(),
      otpTimeout: this.mobileOtpTimeoutMessage(),
      otpVerified: this.mobileOtpVerifiedMessage(),

      // Step 4
      orderVerifying: this.orderVerifyingMessage(),
      orderFailed: this.orderVerificationFailedMessage('test'),
      orderVerified: this.orderVerifiedMessage(),

      // Step 5
      binancePaymentWaiting: this.binancePaymentWaitingMessage(),
      binancePaymentTimeout: this.binancePaymentTimeoutMessage(),
      paymentLink: this.paymentLinkMessage('https://pay.example.com'),
      paymentQr: this.paymentQrCodeMessage(),
      paymentWaiting: this.paymentWaitingMessage(),
      paymentTimeout: this.paymentTimeoutMessage(),

      // Step 6
      paymentReceived: this.paymentReceivedMessage(),
      orderCompleted: this.orderCompletedMessage(),

      // Error
      genericError: this.genericErrorMessage(),
      orderCancelled: this.orderCancelledMessage('test reason')
    };
  }
}

module.exports = new SellerMessages();
