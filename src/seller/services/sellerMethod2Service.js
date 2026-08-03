/**
 * Method 2: Document verification (seller side).
 *
 * Flow (runs AFTER liveness completes, only when the ad has Method 2 enabled):
 *   1. Fetch all images the buyer uploaded in the Binance chat.
 *   2. OpenAI vision → classify (aadhaar_front / aadhaar_back / pan) + extract
 *      Aadhaar name, PAN number, PAN name.
 *   3. Require Aadhaar FRONT + Aadhaar BACK + PAN. Ask for whatever is missing.
 *   4. Aadhaar name  ⟷ Binance KYC name   (matchNames)
 *   5. PAN number → Surepass verify → PAN registered name.
 *   6. PAN name     ⟷ Binance KYC name   (matchNames)
 *   7. All pass → verified. Any mismatch/failure → ask buyer to re-upload
 *      (max 3 attempts per document, then "limit exceeded, cancel the order").
 *
 * NOTE: this REUSES the shared utilities panService.verifyPAN() and
 * helpers.matchNames() — the same verification/name-match logic the buyer side
 * uses — but does NOT modify any buyer-side code. It is a separate seller service.
 */

const logger = require('../../utils/logger');
const { matchNames } = require('../../utils/helpers');
const { verifyPAN } = require('../../services/panService');
const openaiVision = require('./openaiVisionService');
const sellerBinanceService = require('./sellerBinanceService');
const sellerOrderDbService = require('./sellerOrderDbService');

const MAX_ATTEMPTS = 3;

// Result the handler acts on.
//   status: 'verified' | 'need_upload' | 'name_mismatch' | 'pan_failed' | 'limit_exceeded' | 'error'
//   message: text to send the buyer in chat (null when nothing to send)
function res(status, message = null, extra = {}) {
  return { status, message, ...extra };
}

/**
 * Run one pass of Method 2 verification for an order.
 * Called on each poll cycle / whenever new images may have arrived.
 */
async function runVerification(orderNo, kycName, providedImages = null) {
  try {
    // ---- 1) Images ----
    // The caller (handler) passes the settled image list so we only call OpenAI
    // once uploads have stopped arriving. If not provided, fetch fresh.
    let images = providedImages;
    if (!images) {
      const imgResult = await sellerBinanceService.getBuyerUploadedImages(orderNo);
      if (!imgResult.success) {
        return res('error', null, { detail: imgResult.message });
      }
      images = imgResult.images || [];
    }
    if (images.length === 0) {
      // Nothing uploaded yet — just wait, don't consume an attempt.
      return res('need_upload', null, { waiting: true });
    }

    // ---- 2) OpenAI classify + extract (ALL images in ONE call) ----
    const urls = images.map((i) => i.imageUrl);
    const ai = await openaiVision.classifyAndExtract(urls);
    if (!ai.success) {
      return res('error', null, { detail: ai.message });
    }

    const items = ai.images || [];
    const aadhaarFront = items.find((x) => x.type === 'aadhaar_front');
    const aadhaarBack = items.find((x) => x.type === 'aadhaar_back');
    // Accept either "pan" or (legacy) "pan_front" — PAN number + name are on the front.
    const pan = items.find((x) => x.type === 'pan' || x.type === 'pan_front');

    // ---- OpenAI extraction result (terminal log) ----
    console.log(`\n🔎 [${orderNo}] OpenAI classification (${items.length} images):`);
    items.forEach((it, i) =>
      console.log(`    [${i}] type=${it.type}` + (it.name ? `  name="${it.name}"` : '') + (it.pan_number ? `  pan=${it.pan_number}` : ''))
    );
    console.log(`    → Aadhaar name : ${aadhaarFront?.name || '(none)'}`);
    console.log(`    → PAN number   : ${pan?.pan_number || '(none)'}`);
    console.log(`    → PAN name(AI) : ${pan?.name || '(none)'}`);
    console.log(`    → Binance KYC  : ${kycName}`);

    // ---- 3) Require Aadhaar (front+back) + PAN = 3 documents ----
    // PAN back is not needed (blank/QR, nothing to verify).
    const missing = [];
    if (!aadhaarFront) missing.push('Aadhaar front side');
    if (!aadhaarBack) missing.push('Aadhaar back side');
    if (!pan) missing.push('PAN card');

    if (missing.length > 0) {
      // Waiting on documents. Don't burn an attempt just for a missing upload.
      return res(
        'need_upload',
        `Please upload the following clear image(s): ${missing.join(', ')}.`,
        { missing, waiting: true }
      );
    }

    // ============ ALL DOCS PRESENT — VERIFY ============

    // ---- 4) Aadhaar name ⟷ KYC name ----
    const aadhaarName = aadhaarFront.name;
    if (!aadhaarName) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'aadhaar');
      if (n > MAX_ATTEMPTS) return limitExceeded('Aadhaar');
      return res(
        'need_upload',
        `Could not read the name on your Aadhaar. Please re-upload a clear Aadhaar front image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
    }
    await sellerOrderDbService.saveAadhaarName(orderNo, aadhaarName);

    console.log(`    Aadhaar name ⟷ KYC: "${aadhaarName}" vs "${kycName}"`);
    const aadhaarMatch = matchNames(kycName, aadhaarName);
    if (!aadhaarMatch.matched) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'aadhaar');
      if (n > MAX_ATTEMPTS) return limitExceeded('Aadhaar');
      logger.info(`[${orderNo}] Aadhaar name mismatch`, { kycName, aadhaarName, reason: aadhaarMatch.reason });
      return res(
        'name_mismatch',
        `Name mismatch on Aadhaar: your Binance KYC name is "${kycName}" but the Aadhaar shows "${aadhaarName}". ` +
          `Please upload a matching Aadhaar (front & back). (Attempt ${n}/${MAX_ATTEMPTS})`
      );
    }

    // ---- 5) PAN number → Surepass verify ----
    const panNumber = pan.pan_number;
    if (!panNumber) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN');
      return res(
        'need_upload',
        `Could not read the PAN number. Please re-upload a clear PAN card image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
    }

    const panCheck = await verifyPAN(panNumber);
    console.log(`\n🔐 [${orderNo}] Surepass PAN verify:`);
    console.log(`    PAN number    : ${panNumber}`);
    console.log(`    valid         : ${panCheck.valid}`);
    console.log(`    Surepass name : ${panCheck.name || '(none)'}`);
    if (panCheck.reason) console.log(`    reason        : ${panCheck.reason}`);
    if (!panCheck.valid) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN');
      logger.info(`[${orderNo}] PAN verify failed`, { panNumber, reason: panCheck.reason });
      return res(
        'pan_failed',
        `PAN verification failed (${panCheck.reason || 'not verified'}). ` +
          `Please re-upload a clear, valid PAN card image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
    }

    const panName = panCheck.name || pan.name;
    await sellerOrderDbService.savePanDetails(orderNo, panNumber, panName);

    // ---- 6) PAN name ⟷ KYC name ----
    console.log(`    PAN name ⟷ KYC: "${panName}" vs "${kycName}"`);
    const panMatch = matchNames(kycName, panName);
    if (!panMatch.matched) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN');
      logger.info(`[${orderNo}] PAN name mismatch`, { kycName, panName, reason: panMatch.reason });
      return res(
        'name_mismatch',
        `Name mismatch on PAN: your Binance KYC name is "${kycName}" but the PAN shows "${panName}". ` +
          `Please upload a matching PAN card. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
    }

    // ---- 7) All good ----
    console.log(`\n✅ [${orderNo}] METHOD 2 VERIFIED`);
    console.log(`    Aadhaar name : ${aadhaarName}`);
    console.log(`    PAN number   : ${panNumber}`);
    console.log(`    PAN name     : ${panName} (Surepass)`);
    console.log(`    Binance KYC  : ${kycName}\n`);
    logger.info(`[${orderNo}] ✅ Method 2 documents verified`, { aadhaarName, panName, panNumber });
    return res('verified', null, { aadhaarName, panName, panNumber });
  } catch (error) {
    logger.error(`[${orderNo}] Method 2 verification error: ${error.message}`, { error });
    return res('error', null, { detail: error.message });
  }
}

function limitExceeded(doc) {
  return res(
    'limit_exceeded',
    `You have exceeded the ${doc} verification limit. ` +
      `I cannot verify this order — you can cancel this order.`
  );
}

module.exports = { runVerification, MAX_ATTEMPTS };
