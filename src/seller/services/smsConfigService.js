/**
 * SMS OTP config (editable from the frontend SMS Settings section).
 *
 * Stores the OTP text + its matching DLT Template Id together, so the admin can
 * change the template and its DLT id as a pair at runtime. Empty values fall back
 * to env (SMS_OTP_TEMPLATE / SMS_DLT_TEMPLATE_ID) and then the hardcoded default.
 *
 * Cached 30s so we don't hit the DB on every OTP send; an edit invalidates it.
 */

const { pool } = require('../../config/mysql');
const logger = require('../../utils/logger');

const CACHE_TTL_MS = 30_000;
let _cache = null;
let _at = 0;

async function _load() {
  try {
    const [rows] = await pool.query('SELECT otp_template, dlt_template_id FROM seller_sms_config WHERE id = 1');
    _cache = rows[0] || { otp_template: null, dlt_template_id: null };
  } catch (err) {
    logger.warn(`smsConfig load failed: ${err.message}`);
    if (!_cache) _cache = { otp_template: null, dlt_template_id: null };
  }
  _at = Date.now();
}

async function _get() {
  if (!_cache || Date.now() - _at > CACHE_TTL_MS) await _load();
  return _cache;
}

/** OTP text from DB (or null). */
async function getOtpTemplate() {
  return (await _get()).otp_template || null;
}

/** DLT template id from DB (or null → caller falls back to env). */
async function getDltTemplateId() {
  const v = (await _get()).dlt_template_id;
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Read both, plus the effective (DB → env) values for display. */
async function getConfig() {
  const c = await _get();
  return {
    otpTemplate: c.otp_template || '',
    dltTemplateId: c.dlt_template_id || '',
    // What the bot will actually use right now (DB first, else env/default).
    effectiveDltTemplateId: (c.dlt_template_id && String(c.dlt_template_id).trim())
      ? String(c.dlt_template_id).trim()
      : (process.env.SMS_DLT_TEMPLATE_ID || ''),
  };
}

/** Save the OTP text + DLT template id together. */
async function setConfig({ otpTemplate, dltTemplateId }) {
  await pool.query(
    `INSERT INTO seller_sms_config (id, otp_template, dlt_template_id)
       VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE otp_template = VALUES(otp_template),
                             dlt_template_id = VALUES(dlt_template_id),
                             updated_at = NOW()`,
    [otpTemplate ?? null, dltTemplateId ?? null]
  );
  invalidate();
  return true;
}

function invalidate() {
  _cache = null;
  _at = 0;
}

module.exports = { getOtpTemplate, getDltTemplateId, getConfig, setConfig, invalidate };
