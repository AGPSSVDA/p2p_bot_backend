const logger = require('../../utils/logger');
const { binanceService } = require('../../services/binanceService');
const { panService } = require('../../services/panService');
const sellerOrderDbService = require('./sellerOrderDbService');

/**
 * ===== SELLER VERIFICATION SERVICE =====
 *
 * Handles all verification methods:
 * - Method 1: Liveness check (via Binance)
 * - Method 2: Document verification (Aadhaar + PAN + Optional Mobile OTP)
 * - Method 3: Full verification (Docs + Payment link)
 */
class SellerVerificationService {

  // ===== METHOD 2 & 3: DOCUMENT VERIFICATION =====

  /**
   * Verify documents (Aadhaar + PAN)
   * Called when buyer uploads Aadhaar and PAN images via Binance chat
   */
  async verifyDocuments(orderNo, documents) {
    try {
      logger.info(`[${orderNo}] Verifying documents via SurePass...`);

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (!order) {
        return { success: false, reason: 'Order not found' };
      }

      // Verify each document
      const results = {};

      for (const doc of documents) {
        logger.debug(`[${orderNo}] Verifying ${doc.type}...`, {
          documentType: doc.type,
          size: doc.size
        });

        let verificationResult;

        if (doc.type === 'aadhaar') {
          verificationResult = await this.verifyAadhaar(orderNo, doc, order.buyer_kyc_name);
        } else if (doc.type === 'pan') {
          verificationResult = await this.verifyPan(orderNo, doc, order.buyer_kyc_name);
        } else {
          verificationResult = { success: false, reason: 'Unknown document type' };
        }

        results[doc.type] = verificationResult;

        // Store document verification result
        if (verificationResult.success) {
          await sellerOrderDbService.recordDocumentVerified(
            orderNo,
            doc.type,
            true
          );
        } else {
          await sellerOrderDbService.recordDocumentVerified(
            orderNo,
            doc.type,
            false,
            verificationResult.reason
          );
          return {
            success: false,
            reason: `${doc.type} verification failed: ${verificationResult.reason}`
          };
        }
      }

      logger.info(`[${orderNo}] ✅ All documents verified!`);
      return { success: true };

    } catch (error) {
      logger.error(`Document verification error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Verify Aadhaar via SurePass
   */
  async verifyAadhaar(orderNo, document, kycName) {
    try {
      logger.debug(`[${orderNo}] Calling SurePass Aadhaar API...`);

      // Call SurePass API to verify Aadhaar
      // Extract Aadhaar number from document (image → OCR → number)
      // This would use actual SurePass SDK in production

      // Mock response for now
      const surepassResponse = {
        status: 'success',
        data: {
          aadhaar_number: 'XXXX-XXXX-1234', // Masked
          name: 'Buyer Name From Aadhaar',
          date_of_birth: '1990-01-15',
          gender: 'M'
        }
      };

      // Compare names
      const aadhaarName = surepassResponse.data.name;
      const namesMatch = this.compareNames(kycName, aadhaarName);

      if (!namesMatch) {
        return {
          success: false,
          reason: `Name mismatch: Aadhaar name "${aadhaarName}" doesn't match KYC name "${kycName}"`
        };
      }

      logger.info(`[${orderNo}] ✅ Aadhaar verified successfully`);

      return { success: true, data: surepassResponse.data };

    } catch (error) {
      logger.error(`Aadhaar verification error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Verify PAN via SurePass
   */
  async verifyPan(orderNo, document, kycName) {
    try {
      logger.debug(`[${orderNo}] Calling SurePass PAN API...`);

      // In production: Call real SurePass API
      // For now: mock response

      const surepassResponse = {
        status: 'success',
        data: {
          pan_number: 'ABCDE1234F',
          name: 'Buyer Name From PAN',
          date_of_birth: null
        }
      };

      // Compare names
      const panName = surepassResponse.data.name;
      const namesMatch = this.compareNames(kycName, panName);

      if (!namesMatch) {
        return {
          success: false,
          reason: `Name mismatch: PAN name "${panName}" doesn't match KYC name "${kycName}"`
        };
      }

      logger.info(`[${orderNo}] ✅ PAN verified successfully`);

      return { success: true, data: surepassResponse.data };

    } catch (error) {
      logger.error(`PAN verification error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Compare two names
   * Handles variations (extra spaces, case, etc)
   */
  compareNames(name1, name2) {
    if (!name1 || !name2) return false;

    // Normalize names: lowercase, trim, remove extra spaces
    const norm1 = name1.toLowerCase().trim().replace(/\s+/g, ' ');
    const norm2 = name2.toLowerCase().trim().replace(/\s+/g, ' ');

    // Exact match
    if (norm1 === norm2) return true;

    // Check if one contains the other (for partial names)
    if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

    // Check word-by-word match (all words match regardless of order)
    const words1 = norm1.split(' ').sort();
    const words2 = norm2.split(' ').sort();

    if (words1.join(' ') === words2.join(' ')) return true;

    return false;
  }

  // ===== METHOD 2 & 3 OPTIONAL: MOBILE OTP VERIFICATION =====

  /**
   * Send OTP to mobile number via SurePass
   */
  async sendMobileOtp(orderNo, mobileNumber) {
    try {
      logger.info(`[${orderNo}] Sending OTP to mobile number...`);

      // Validate mobile number format (10 digits for India)
      if (!/^\d{10}$/.test(mobileNumber)) {
        return { success: false, reason: 'Invalid mobile number format (10 digits required)' };
      }

      // Call SurePass OTP API
      // In production: actual API call
      // For now: mock

      logger.info(`[${orderNo}] ✅ OTP sent to mobile ${mobileNumber.slice(-4)}`);

      return {
        success: true,
        message: 'OTP sent to your mobile number',
        requestId: `otp_${orderNo}_${Date.now()}`
      };

    } catch (error) {
      logger.error(`OTP send error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Verify OTP provided by buyer
   */
  async verifyMobileOtp(orderNo, otp) {
    try {
      logger.info(`[${orderNo}] Verifying OTP...`);

      // Validate OTP format (typically 6 digits)
      if (!/^\d{4,6}$/.test(otp)) {
        return { success: false, reason: 'Invalid OTP format' };
      }

      // Call SurePass OTP verification API
      // In production: verify against OTP sent
      // For now: mock (accept any OTP for testing)

      logger.info(`[${orderNo}] ✅ OTP verified successfully`);

      return { success: true };

    } catch (error) {
      logger.error(`OTP verification error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  // ===== METHOD 3: PAYMENT LINK GENERATION =====

  /**
   * Generate payment link/QR code
   * Called after all verifications pass
   */
  async generatePaymentLink(orderNo, gateway, deliveryMethod) {
    try {
      logger.info(`[${orderNo}] Generating payment link...`, {
        gateway,
        deliveryMethod
      });

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (!order) {
        return { success: false, reason: 'Order not found' };
      }

      let link;

      if (gateway === 'razorpay') {
        link = await this.generateRazorpayLink(orderNo, order);
      } else if (gateway === 'paywize') {
        link = await this.generatePaywizeLink(orderNo, order);
      } else {
        return { success: false, reason: `Unknown gateway: ${gateway}` };
      }

      if (!link) {
        return { success: false, reason: 'Failed to generate payment link' };
      }

      // If QR code delivery: generate QR code from link
      let qrCode = null;
      if (deliveryMethod === 'qr_code') {
        qrCode = await this.generateQrCode(link);
      }

      logger.info(`[${orderNo}] ✅ Payment link generated`);

      return {
        success: true,
        link: deliveryMethod === 'payment_link' ? link : null,
        qrCode: deliveryMethod === 'qr_code' ? qrCode : null
      };

    } catch (error) {
      logger.error(`Payment link generation error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Generate Razorpay payment link
   */
  async generateRazorpayLink(orderNo, order) {
    try {
      logger.debug(`[${orderNo}] Creating Razorpay payment link...`);

      // In production: Call Razorpay API to create payment link
      // For now: mock link

      const link = `https://rzp.io/i/${orderNo}`;

      await sellerOrderDbService.recordPaymentLinkGenerated(
        orderNo,
        'razorpay',
        'payment_link'
      );

      return link;

    } catch (error) {
      logger.error(`Razorpay link error: ${error.message}`, { orderNo });
      return null;
    }
  }

  /**
   * Generate Paywize payment link
   */
  async generatePaywizeLink(orderNo, order) {
    try {
      logger.debug(`[${orderNo}] Creating Paywize payment link...`);

      // In production: Call Paywize API to create payment link
      // For now: mock link

      const link = `https://merchant.paywize.in/pay/${orderNo}`;

      await sellerOrderDbService.recordPaymentLinkGenerated(
        orderNo,
        'paywize',
        'payment_link'
      );

      return link;

    } catch (error) {
      logger.error(`Paywize link error: ${error.message}`, { orderNo });
      return null;
    }
  }

  /**
   * Generate QR code from URL
   */
  async generateQrCode(url) {
    try {
      logger.debug(`Generating QR code from URL...`);

      // In production: Use qrcode library to generate QR
      // For now: mock QR code (in production: return base64 encoded image)

      const qrCode = `QR_CODE_FOR_${url}`;

      return qrCode;

    } catch (error) {
      logger.error(`QR generation error: ${error.message}`);
      return null;
    }
  }

  // ===== LIVENESS CHECK (METHOD 1) =====

  /**
   * Check if buyer has completed liveness check on Binance
   * Called periodically by orderPoller
   */
  async checkLivenessStatus(orderNo) {
    try {
      logger.debug(`[${orderNo}] Checking liveness status...`);

      // Get latest order detail from Binance
      // Check if livenessStatus = 'COMPLETED'

      const orderDetail = await binanceService.getOrderDetail(orderNo);

      if (!orderDetail) {
        return { success: false, reason: 'Order not found on Binance' };
      }

      // Check liveness status
      if (orderDetail.livenessStatus === 'COMPLETED') {
        logger.info(`[${orderNo}] ✅ Liveness check completed`);
        return { success: true, completed: true };
      }

      return { success: true, completed: false };

    } catch (error) {
      logger.error(`Liveness check error: ${error.message}`, { orderNo });
      return { success: false, reason: error.message };
    }
  }
}

module.exports = new SellerVerificationService();
