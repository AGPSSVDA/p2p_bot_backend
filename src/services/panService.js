const axios  = require('axios');
const { config }                                 = require('../config/config');
const { isValidPANFormat, maskPAN, withRetry }   = require('../utils/helpers');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  PAN Verification — Surepass /api/v1/pan/pan
//
//  Phase 1 (no SUREPASS_TOKEN): format-only check
//  Phase 2 (SUREPASS_TOKEN set): real govt-DB call
//
//  Surepass response shape:
//    {
//      data: {
//        client_id, pan_number, full_name, category    // category: "person" / "company"
//      },
//      status_code: 200,
//      success: true,
//      message_code: "success"
//    }
// ─────────────────────────────────────────────────────────────────────────────

async function verifyPAN(pan) {
  const cleanPan = (pan || '').toUpperCase().trim();

  // Step 1 — format check (free, always)
  if (!isValidPANFormat(cleanPan)) {
    return { valid: false, reason: 'Invalid format. Correct format: ABCDE1234F', source: 'format' };
  }

  // Step 2 — Phase 1 (no Surepass token): format-only pass
  if (!config.features.panVerification) {
    logger.info('PAN format-only check passed (Phase 1)', { pan: maskPAN(cleanPan) });
    return {
      valid: true,
      name:  null,                  // no real name available in Phase 1
      pan:   cleanPan,
      source: 'format_only',
    };
  }

  // Step 3 — Phase 2: Surepass real verification
  //   IMPORTANT: validateStatus:()=>true so axios never throws on HTTP errors.
  //   Surepass returns 422 + {success:false, message:"Invalid PAN"} for PANs
  //   that don't exist in govt registry — that's a DEFINITIVE answer, not
  //   a transient failure. We must surface it as { valid:false } (so seller
  //   can re-enter) instead of throwing (which would escalate the order).
  return withRetry(async () => {
    const res = await axios.post(
      `${config.surepass.baseUrl}${config.surepass.endpoint}`,
      { id_number: cleanPan },
      {
        headers: {
          'Authorization': `Bearer ${config.surepass.token}`,
          'Content-Type':  'application/json',
        },
        timeout:        15000,
        validateStatus: () => true,   // never throw on HTTP status
      }
    );

    const status = res.status;
    const body   = res.data || {};
    const data   = body.data || {};

    // 5xx → real server failure, retry
    if (status >= 500) {
      throw new Error(`Surepass HTTP ${status}: ${body.message || 'server error'}`);
    }

    // 401/403 → token issue, don't retry
    if (status === 401 || status === 403) {
      logger.error('Surepass token rejected — check SUREPASS_TOKEN/SUREPASS_API_TOKEN', {
        pan: maskPAN(cleanPan), status, message: body.message,
      });
      return {
        valid:  false,
        reason: 'PAN verification temporarily unavailable',
        source: 'surepass_auth',
      };
    }

    // 4xx with success:false → definitive "invalid" — seller must re-enter
    if (!body.success) {
      const msg = body.message || body.message_code || 'PAN does not exist in registry';
      logger.info('Surepass marked PAN invalid', {
        pan:    maskPAN(cleanPan),
        status, message: msg,
        panFromApi: data.pan_number || null,
        category:   data.category   || null,
      });
      return { valid: false, reason: msg, source: 'surepass' };
    }

    // success:true path
    const fullName = (data.full_name || '').trim();
    const category = String(data.category || '').toLowerCase();

    if (!fullName) {
      return { valid: false, reason: 'PAN does not exist in registry', source: 'surepass' };
    }

    if (category && category !== 'person') {
      return {
        valid:  false,
        reason: `Only individual PAN is accepted (got: ${category})`,
        source: 'surepass',
      };
    }

    logger.info('Surepass PAN verified', {
      pan:  maskPAN(cleanPan),
      name: fullName,
      category,
    });

    return {
      valid: true,
      name:  fullName,
      pan:   cleanPan,
      category,
      source: 'surepass',
      raw:    data,
    };
  }, 2, 5000, `verifyPAN:${maskPAN(cleanPan)}`);
}

module.exports = { verifyPAN };
