/**
 * Method 2: Document verification (seller side) — INCREMENTAL, per-image flow.
 *
 * Flow (runs AFTER liveness completes, only when the ad has Method 2 enabled):
 *   1. The handler asks the buyer (in chat) to upload Aadhaar front, Aadhaar back
 *      and PAN. The buyer can send them in ANY order, ANY count, ANY layout
 *      (one image per doc, or several docs stacked in one screenshot / e-Aadhaar
 *      PDF screenshot).
 *   2. The handler feeds EACH new image to processImage() one at a time.
 *   3. processImage() classifies + extracts (OpenAI single-image), then routes:
 *        aadhaar_front → extract name → match Binance KYC name → mark Aadhaar
 *                        FRONT verified (aadhaar_verification_passed).
 *        aadhaar_back  → mark Aadhaar BACK seen.
 *        pan           → PAN number → Surepass verify → name match → mark PAN
 *                        verified (pan_verification_passed).
 *        unknown/unreadable → tell the buyer this isn't Aadhaar/PAN or couldn't
 *                        be read.
 *   4. Already-verified doc types are skipped (their further images are ignored).
 *   5. Each failed READ/MATCH consumes an attempt for that doc; 3 attempts →
 *      "limit exceeded, cancel the order".
 *   6. When Aadhaar front + Aadhaar back + PAN are all done, the order is verified.
 *
 * This REUSES the shared utilities panService.verifyPAN() and helpers.matchNames()
 * — the same verification/name-match logic the buyer side uses — but does NOT
 * modify any buyer-side code. It is a separate seller service.
 */

const logger = require('../../utils/logger');
// Seller uses a LOOSER name match than the buyer side: case-insensitive, and a
// first-name OR last-name match (prefix-tolerant, e.g. "Firoj" ≈ "Firojabhai")
// counts as a match. Buyer-side helpers.matchNames() is left untouched.
const { matchNamesLoose: matchNames } = require('../utils/sellerUtils');
const { verifyPAN } = require('../../services/panService');
const openaiVision = require('./openaiVisionService');
const sellerOrderDbService = require('./sellerOrderDbService');
const sellerMessageService = require('./sellerMessageService');

const MAX_ATTEMPTS = 3;

// Result the handler acts on.
//   status:
//     'aadhaar_verified' | 'aadhaar_back_seen' | 'pan_verified'  → progress
//     'name_mismatch' | 'pan_failed' | 'unreadable' | 'not_a_document' → retry msg
//     'limit_exceeded' → stop, ask buyer to cancel
//     'ignored' → image was a doc type already verified (no message)
//     'error'  → transient failure (retry silently)
//   message: text to send the buyer in chat (null when nothing to send)
function res(status, message = null, extra = {}) {
  return { status, message, ...extra };
}

/**
 * Process ONE image for an order and advance the verification state.
 *
 * A single image may contain MORE THAN ONE document (e.g. an e-Aadhaar screenshot
 * with front + back). We handle every document detected in the image, in priority
 * order (Aadhaar front → PAN → Aadhaar back), and return the most significant
 * result so the handler can react (verify progress / send a message / stop).
 *
 * @param {string} orderNo
 * @param {string} kycName   Binance KYC name to match against
 * @param {string} imageUrl  the single image URL to classify
 * @returns {Promise<{status, message, classifiedType?}>}
 */
async function processImage(orderNo, kycName, imageUrl) {
  try {
    // ---- Classify + extract this single image (may hold several documents) ----
    const ai = await openaiVision.classifyImage(imageUrl, orderNo);
    if (!ai.success) {
      // Artificial OpenAI credit exhausted → send buyer a generic message and
      // stop trying (do NOT keep retrying this image).
      if (ai.creditExhausted) {
        const message = await sellerMessageService.get(
          'seller_verification_unavailable',
          {},
          'Sorry, document verification is temporarily unavailable. Please try again later or cancel this order.'
        );
        return res('unavailable', message, { classifiedType: 'unknown' });
      }
      return res('error', null, { detail: ai.message });
    }
    const docs = ai.documents || [];

    console.log(`\n🔎 [${orderNo}] Image classified: ${docs.length} document(s) → ` +
      docs.map((d) => d.type).join(', ') || '(none)');

    // No Indian ID detected at all.
    if (docs.length === 0) {
      const state = await sellerOrderDbService.getMethod2State(orderNo);
      const missing = missingDocsList(state);
      const message = await sellerMessageService.get(
        'seller_doc_not_document',
        { missing },
        `This image is not a valid Aadhaar or PAN, or it could not be read. ${missing ? 'Please upload a clear image of: ' + missing + '.' : ''}`.trim()
      );
      return res('not_a_document', message, { classifiedType: 'unknown' });
    }

    // Handle documents in a sensible priority so the "most significant" result
    // (a match/mismatch/limit that needs a chat reply) is what we return.
    const order = { aadhaar_front: 0, pan: 1, pan_front: 1, aadhaar_back: 2, unknown: 3 };
    const sorted = [...docs].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

    let best = null;
    const rank = {
      limit_exceeded: 6, name_mismatch: 5, pan_failed: 5, unreadable: 4,
      aadhaar_verified: 3, pan_verified: 3, aadhaar_back_seen: 2,
      not_a_document: 1, ignored: 0,
    };
    const keepBest = (r) => {
      if (!best || (rank[r.status] ?? 0) >= (rank[best.status] ?? 0)) best = r;
    };

    for (const doc of sorted) {
      const r = await processOneDoc(orderNo, kycName, doc);
      keepBest(r);
      // A limit-exceeded is terminal — return immediately.
      if (r.status === 'limit_exceeded') return r;
    }

    return best || res('ignored', null, { classifiedType: 'unknown' });
  } catch (error) {
    logger.error(`[${orderNo}] Method 2 processImage error: ${error.message}`, { error });
    return res('error', null, { detail: error.message });
  }
}

/**
 * Advance verification for ONE detected document (aadhaar_front / aadhaar_back /
 * pan). Reads fresh state each call so multiple docs in one image compose.
 */
async function processOneDoc(orderNo, kycName, doc) {
  const state = await sellerOrderDbService.getMethod2State(orderNo);
  const type = doc.type || 'unknown';

  // ============ AADHAAR FRONT ============
  if (type === 'aadhaar_front') {
    if (state.aadhaarFront) return res('ignored', null, { classifiedType: type });

    const aadhaarName = doc.name;
    if (!aadhaarName) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'aadhaar');
      if (n > MAX_ATTEMPTS) return limitExceeded('Aadhaar', type);
      const message = await sellerMessageService.get(
        'seller_doc_unreadable',
        { docType: 'Aadhaar', attempt: n, maxAttempts: MAX_ATTEMPTS },
        `Could not read your Aadhaar. Please re-upload a clear image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('unreadable', message, { classifiedType: type });
    }

    await sellerOrderDbService.saveAadhaarName(orderNo, aadhaarName);
    console.log(`    Aadhaar name ⟷ KYC: "${aadhaarName}" vs "${kycName}"`);
    const m = matchNames(kycName, aadhaarName);
    if (!m.matched) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'aadhaar');
      if (n > MAX_ATTEMPTS) return limitExceeded('Aadhaar', type);
      logger.info(`[${orderNo}] Aadhaar name mismatch`, { kycName, aadhaarName, reason: m.reason });
      const message = await sellerMessageService.get(
        'seller_doc_name_mismatch',
        { docType: 'Aadhaar', kycName, docName: aadhaarName, attempt: n, maxAttempts: MAX_ATTEMPTS },
        `Name mismatch on Aadhaar: your Binance KYC name is "${kycName}" but the Aadhaar shows "${aadhaarName}". ` +
          `Please upload a matching Aadhaar. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('name_mismatch', message, { classifiedType: type });
    }

    await sellerOrderDbService.recordDocumentVerified(orderNo, 'aadhaar', true);
    logger.info(`[${orderNo}] ✅ Aadhaar front verified (name matched)`, { aadhaarName });
    return res('aadhaar_verified', null, { classifiedType: type, aadhaarName });
  }

  // ============ AADHAAR BACK ============
  if (type === 'aadhaar_back') {
    if (state.aadhaarBack) return res('ignored', null, { classifiedType: type });
    await sellerOrderDbService.setAadhaarBackSeen(orderNo);
    logger.info(`[${orderNo}] ✅ Aadhaar back seen`);
    return res('aadhaar_back_seen', null, { classifiedType: type });
  }

  // ============ PAN ============
  if (type === 'pan' || type === 'pan_front') {
    if (state.pan) return res('ignored', null, { classifiedType: 'pan' });

    const panNumber = doc.pan_number;
    if (!panNumber) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN', 'pan');
      const message = await sellerMessageService.get(
        'seller_doc_unreadable',
        { docType: 'PAN', attempt: n, maxAttempts: MAX_ATTEMPTS },
        `Could not read your PAN. Please re-upload a clear image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('unreadable', message, { classifiedType: 'pan' });
    }

    const panCheck = await verifyPAN(panNumber);
    console.log(`\n🔐 [${orderNo}] Surepass PAN verify: ${panNumber} → valid=${panCheck.valid} name="${panCheck.name || ''}"`);
    if (!panCheck.valid) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN', 'pan');
      logger.info(`[${orderNo}] PAN verify failed`, { panNumber, reason: panCheck.reason });
      const message = await sellerMessageService.get(
        'seller_doc_pan_failed',
        { reason: panCheck.reason || 'not verified', attempt: n, maxAttempts: MAX_ATTEMPTS },
        `PAN verification failed (${panCheck.reason || 'not verified'}). ` +
          `Please re-upload a clear, valid PAN card image. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('pan_failed', message, { classifiedType: 'pan' });
    }

    const panName = panCheck.name || doc.name;
    await sellerOrderDbService.savePanDetails(orderNo, panNumber, panName);
    console.log(`    PAN name ⟷ KYC: "${panName}" vs "${kycName}"`);
    const m = matchNames(kycName, panName);
    if (!m.matched) {
      const n = await sellerOrderDbService.incrementDocAttempt(orderNo, 'pan');
      if (n > MAX_ATTEMPTS) return limitExceeded('PAN', 'pan');
      logger.info(`[${orderNo}] PAN name mismatch`, { kycName, panName, reason: m.reason });
      const message = await sellerMessageService.get(
        'seller_doc_name_mismatch',
        { docType: 'PAN', kycName, docName: panName, attempt: n, maxAttempts: MAX_ATTEMPTS },
        `Name mismatch on PAN: your Binance KYC name is "${kycName}" but the PAN shows "${panName}". ` +
          `Please upload a matching PAN card. (Attempt ${n}/${MAX_ATTEMPTS})`
      );
      return res('name_mismatch', message, { classifiedType: 'pan' });
    }

    await sellerOrderDbService.recordDocumentVerified(orderNo, 'pan', true);
    logger.info(`[${orderNo}] ✅ PAN verified`, { panNumber, panName });
    return res('pan_verified', null, { classifiedType: 'pan', panNumber, panName });
  }

  // Unknown doc type in the array — ignore it.
  return res('ignored', null, { classifiedType: 'unknown' });
}

/** True when all three required documents are done. */
function isComplete(state) {
  return !!(state.aadhaarFront && state.aadhaarBack && state.pan);
}

/** Comma list of documents still pending (empty string when none). */
function missingDocsList(state) {
  const missing = [];
  if (!state.aadhaarFront) missing.push('Aadhaar front');
  if (!state.aadhaarBack) missing.push('Aadhaar back');
  if (!state.pan) missing.push('PAN card');
  return missing.join(', ');
}

/**
 * Chat message reminding the buyer of pending documents (DB template, editable).
 * Returns '' when nothing is missing.
 */
async function missingDocsMessage(state) {
  const missing = missingDocsList(state);
  if (!missing) return '';
  return sellerMessageService.get(
    'seller_doc_missing',
    { missing },
    `Please upload a clear image of: ${missing}.`
  );
}

async function limitExceeded(doc, classifiedType) {
  const message = await sellerMessageService.get(
    'seller_doc_limit_exceeded',
    { docType: doc },
    `You have exceeded the ${doc} verification limit (3 attempts). ` +
      `I cannot verify this order — please cancel this order.`
  );
  return res('limit_exceeded', message, { classifiedType });
}

module.exports = {
  processImage,
  isComplete,
  missingDocsMessage,
  MAX_ATTEMPTS,
};
