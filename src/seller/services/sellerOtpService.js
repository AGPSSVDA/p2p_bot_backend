/**
 * Method 2 OTP (mobile) verification — seller side.
 *
 * Runs AFTER documents are verified, ONLY when the ad has
 * method2_mobile_verification_enabled = 1. Flow:
 *   1. Ask the buyer for a 10-digit mobile number.
 *   2. Buyer replies with a number → validate (10 digits). Invalid → 3 retries.
 *   3. Generate a 6-digit OTP, store it, send via NettyFish SMS (smsService).
 *   4. Buyer replies with the OTP → match against the stored OTP. Wrong → 3 retries.
 *   5. Match → verified (handler verifies the order in Binance).
 * Exceeding either retry limit → "limit exceeded, cancel the order".
 *
 * We generate + verify the OTP ourselves; the SMS gateway only delivers it.
 * All buyer-facing text comes from editable DB templates (sellerMessageService).
 */

const logger = require('../../utils/logger');
const smsService = require('./smsService');
const sellerOrderDbService = require('./sellerOrderDbService');
const sellerMessageService = require('./sellerMessageService');

const MAX_ATTEMPTS = 3;
const OTP_LENGTH = 6;

function res(status, message = null, extra = {}) {
  return { status, message, ...extra };
}

/** Generate a numeric OTP (no leading-zero loss — always OTP_LENGTH digits). */
function generateOtp() {
  let otp = '';
  for (let i = 0; i < OTP_LENGTH; i++) otp += Math.floor(Math.random() * 10);
  return otp;
}

/** Extract a 10-digit Indian mobile number from a free-text chat message. */
function parseMobile(text) {
  if (!text) return null;
  // Strip spaces, dashes, and a leading +91 / 91 / 0.
  const digits = String(text).replace(/[^\d]/g, '');
  let m = digits;
  if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
  else if (m.length === 11 && m.startsWith('0')) m = m.slice(1);
  return /^[6-9]\d{9}$/.test(m) ? m : null;
}

/** Extract an OTP (OTP_LENGTH digits) from a free-text chat message. */
function parseOtp(text) {
  if (!text) return null;
  const digits = String(text).replace(/[^\d]/g, '');
  return digits.length === OTP_LENGTH ? digits : null;
}

/**
 * Handle a buyer chat message during the OTP flow.
 *
 * The handler routes here whenever a text message arrives while the order is in
 * the OTP stage. We decide, from stored state, whether we're waiting for the
 * mobile number or the OTP, and act accordingly.
 *
 * @returns status:
 *   'otp_sent'        → OTP sent, now waiting for the OTP (message = confirm text)
 *   'need_mobile'     → still waiting for a valid mobile number (message = ask)
 *   'invalid_mobile'  → wrong mobile, retry (message)
 *   'invalid_otp'     → wrong OTP, retry (message)
 *   'send_failed'     → SMS gateway failed (message)
 *   'verified'        → OTP matched → verify the order
 *   'limit_exceeded'  → retries exhausted → cancel (message)
 *   'ignored'         → message wasn't relevant (no action)
 */
async function handleMessage(orderNo, text) {
  try {
    const state = await sellerOrderDbService.getOtpState(orderNo);

    // ---- Stage A: no mobile number yet → expect a mobile number ----
    if (!state.mobileNumber) {
      const mobile = parseMobile(text);
      if (!mobile) {
        // Pure chit-chat with (almost) no digits ("payment link", "share kro",
        // "bhai urgent hai") is NOT a mobile-number attempt — ignore it so it
        // doesn't burn an attempt. Only count it as a wrong attempt when the
        // buyer clearly tried to send a number (has several digits).
        const digitCount = (String(text).match(/\d/g) || []).length;
        if (digitCount < 5) return res('ignored');

        const n = await sellerOrderDbService.incrementOtpAttempt(orderNo, 'mobile');
        if (n > MAX_ATTEMPTS) return limitExceeded();
        const message = await sellerMessageService.get(
          'seller_otp_mobile_invalid',
          { attempt: n, maxAttempts: MAX_ATTEMPTS },
          `That does not look like a valid 10-digit mobile. Please send a valid 10-digit mobile. (Attempt ${n}/${MAX_ATTEMPTS})`
        );
        return res('invalid_mobile', message);
      }
      // Valid number → store + generate + send OTP.
      await sellerOrderDbService.saveMobileNumber(orderNo, mobile);
      return sendOtpFor(orderNo, mobile);
    }

    // ---- Stage B: mobile stored but OTP not sent (previous send failed) ----
    if (!state.otpCode) {
      // Allow the buyer to re-send a (possibly corrected) mobile number.
      const mobile = parseMobile(text) || state.mobileNumber;
      if (parseMobile(text)) await sellerOrderDbService.saveMobileNumber(orderNo, mobile);
      return sendOtpFor(orderNo, mobile);
    }

    // ---- Stage C: OTP sent → expect the OTP ----
    const otp = parseOtp(text);
    if (!otp) {
      // Not an OTP-shaped message — ignore quietly (buyer may chat other things),
      // unless it looks like a new mobile number they want to switch to.
      const newMobile = parseMobile(text);
      if (newMobile && newMobile !== state.mobileNumber) {
        await sellerOrderDbService.saveMobileNumber(orderNo, newMobile);
        return sendOtpFor(orderNo, newMobile);
      }
      return res('ignored');
    }

    if (otp !== state.otpCode) {
      const n = await sellerOrderDbService.incrementOtpAttempt(orderNo, 'otp');
      if (n > MAX_ATTEMPTS) return limitExceeded();
      const message = await sellerMessageService.get(
        'seller_otp_invalid',
        { attempt: n, maxAttempts: MAX_ATTEMPTS },
        `The OTP is invalid. Please enter the correct OTP. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('invalid_otp', message);
    }

    // ---- Match ----
    await sellerOrderDbService.recordDocumentVerified(orderNo, 'mobile', true);
    logger.info(`[${orderNo}] ✅ OTP verified`);
    return res('verified');
  } catch (error) {
    logger.error(`[${orderNo}] OTP handleMessage error: ${error.message}`, { error });
    return res('ignored', null, { detail: error.message });
  }
}

/** Generate + store + send an OTP to `mobile`; return the chat message result. */
async function sendOtpFor(orderNo, mobile) {
  const otp = generateOtp();
  await sellerOrderDbService.saveOtp(orderNo, otp);

  const sent = await smsService.sendOtp(mobile, otp);
  if (!sent.success) {
    // Clear the stored OTP so the buyer can re-trigger by re-sending the number.
    await sellerOrderDbService.saveOtp(orderNo, null);
    logger.warn(`[${orderNo}] OTP SMS send failed: ${sent.message}`);
    const message = await sellerMessageService.get(
      'seller_otp_send_failed',
      {},
      'We could not send the OTP right now. Please re-send your mobile to try again.'
    );
    return res('send_failed', message);
  }

  logger.info(`[${orderNo}] OTP sent to ${mobile.slice(-4)}`);
  const message = await sellerMessageService.get(
    'seller_otp_sent',
    { mobile: mobile.slice(-4) },
    `An OTP has been sent to your mobile ending ${mobile.slice(-4)}. Please enter the OTP here to verify.`
  );
  return res('otp_sent', message);
}

/**
 * First prompt: ask the buyer for their mobile number (handler sends on entry).
 * Method 1 has no document step, so it uses its OWN template that talks about
 * liveness instead of documents. Method 2/3 keep the original document template.
 * @param {string} [method] 'method1' → liveness-worded prompt; anything else → docs.
 */
async function mobileRequestMessage(method) {
  if (method === 'method1') {
    return sellerMessageService.get(
      'seller_m1_otp_mobile_request',
      {},
      'Liveness check completed ✅\nSend me your mobile no for verification.'
    );
  }
  return sellerMessageService.get(
    'seller_otp_mobile_request',
    {},
    'Document verification done. Please send your 10-digit mobile to receive an OTP for verification.'
  );
}

async function limitExceeded() {
  const message = await sellerMessageService.get(
    'seller_otp_limit_exceeded',
    {},
    'You have exceeded the verification limit (3 attempts). I cannot verify this order — please cancel this order.'
  );
  return res('limit_exceeded', message);
}

module.exports = { handleMessage, mobileRequestMessage, MAX_ATTEMPTS };
