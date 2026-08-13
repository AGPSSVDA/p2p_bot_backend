/**
 * SMS service — NettyFish RetailSMS HTTP API (SendSMS).
 *
 * Used by Method 2 OTP verification to deliver an OTP to the buyer's mobile.
 * The gateway only DELIVERS the SMS — it does not generate or verify OTPs. We
 * generate the OTP ourselves, store it, send it here, and verify the buyer's
 * chat reply against the stored value (see sellerOtpService).
 *
 * Official request (GET, query string):
 *   http://retailsms.nettyfish.com/api/mt/SendSMS
 *     ?user=..&password=..&senderid=..&channel=Trans&DCS=0&flashsms=0
 *      &number=91XXXXXXXXXX&text=..&route=..
 *   (APIKey may be used INSTEAD of user+password.)
 *
 * Success response:
 *   {"ErrorCode":"000","ErrorMessage":"Done","JobId":"..","MessageData":[..]}
 *   ErrorCode "000" (or "0") = success; anything else = failure.
 *
 * Env (all values env-driven so they can change without code edits):
 *   SMS_API_URL          endpoint (default retailsms.nettyfish.com SendSMS)
 *   SMS_USER             login username         }
 *   SMS_PASSWORD         login password         } use these...
 *   SMS_API_KEY          APIKey                 } ...OR this instead
 *   SMS_SENDER_ID        approved sender id (6 chars)
 *   SMS_CHANNEL          Trans | Promo (default Trans)
 *   SMS_DCS              data coding (0 normal, 8 unicode; default 0)
 *   SMS_FLASH            flash sms 0/1 (default 0)
 *   SMS_ROUTE            route id
 *   SMS_COUNTRY_CODE     prepended to the 10-digit number (default 91)
 *   SMS_OTP_TEMPLATE     message text with {otp} placeholder (match DLT template)
 *   SMS_DLT_TEMPLATE_ID  (optional) DLT template id  → dlttemplateid
 *   SMS_PEID             (optional) DLT entity PEId   → peid
 *   SMS_TELEMARKETER_ID  (optional) DLT telemarketer  → telemarketerid
 */

const axios = require('axios');
const logger = require('../../utils/logger');

const DEFAULT_URL = 'http://retailsms.nettyfish.com/api/mt/SendSMS';
// Default matches the DLT-approved template ({otp} = the DLT {#var#} variable).
// The gateway REJECTS text that doesn't match the registered DLT template.
const DEFAULT_OTP_TEMPLATE =
  'AGPSS_GLOBAL_PVT: Your OTP for mobile number verification is {otp}. This code is valid for 10 minutes. Do not share this OTP with anyone.';

// Loaded lazily to avoid require cycles.
let _smsConfig = null;
function smsConfig() {
  if (!_smsConfig) _smsConfig = require('./smsConfigService');
  return _smsConfig;
}

/**
 * Build the OTP SMS text with {otp} filled.
 * Priority: DB SMS config (editable on the SMS Settings section, kept in sync with
 * its DLT template id) → env SMS_OTP_TEMPLATE → hardcoded default. It MUST stay
 * identical to the DLT-approved template or the gateway rejects the SMS.
 */
async function otpMessage(otp) {
  const envOrDefault = (process.env.SMS_OTP_TEMPLATE || DEFAULT_OTP_TEMPLATE);
  let tpl = envOrDefault;
  try {
    const dbTpl = await smsConfig().getOtpTemplate();
    if (dbTpl) tpl = dbTpl;
  } catch (e) {
    tpl = envOrDefault; // DB hiccup → still send with env/default
  }
  if (!tpl) tpl = envOrDefault;
  return String(tpl).replace(/\{otp\}/g, otp);
}

/**
 * The DLT template id to send with this SMS. Prefers the DB config (edited
 * alongside the text), else env SMS_DLT_TEMPLATE_ID. Returns null if neither set.
 */
async function dltTemplateId() {
  try {
    const dbId = await smsConfig().getDltTemplateId();
    if (dbId) return dbId;
  } catch (e) { /* fall through to env */ }
  return process.env.SMS_DLT_TEMPLATE_ID || null;
}

/**
 * Send an SMS via NettyFish RetailSMS.
 * @param {string} mobile10  10-digit Indian mobile number
 * @param {string} text      message body
 * @returns {Promise<{success:boolean, message?:string, jobId?:string, messageId?:string, providerResponse?:any}>}
 */
async function sendSms(mobile10, text, opts = {}) {
  const url = process.env.SMS_API_URL || DEFAULT_URL;
  const senderId = process.env.SMS_SENDER_ID;

  // Auth: prefer APIKey, else user+password. One of them must be present.
  const apiKey = process.env.SMS_API_KEY;
  const user = process.env.SMS_USER;
  const password = process.env.SMS_PASSWORD;
  const hasAuth = apiKey || (user && password);

  if (!hasAuth || !senderId) {
    logger.error('SMS not configured: need SMS_SENDER_ID and (SMS_API_KEY or SMS_USER+SMS_PASSWORD)');
    return { success: false, message: 'SMS gateway not configured' };
  }

  const cc = process.env.SMS_COUNTRY_CODE || '91';
  const number = `${cc}${mobile10}`;

  const params = {};
  // Account auth
  if (apiKey) params.APIKey = apiKey;
  else { params.user = user; params.password = password; }
  // Message params (per official docs)
  params.senderid = senderId;
  params.channel = process.env.SMS_CHANNEL || 'Trans';
  params.DCS = process.env.SMS_DCS || '0';
  params.flashsms = process.env.SMS_FLASH || '0';
  params.number = number;
  params.text = text;
  params.route = process.env.SMS_ROUTE || '';
  // Optional DLT params (lowercase names per docs). DLT template id can be
  // supplied by the caller (opts.dltTemplateId — the DB-configured value edited
  // alongside the text); otherwise fall back to env.
  const dltId = opts.dltTemplateId || process.env.SMS_DLT_TEMPLATE_ID;
  if (dltId) params.dlttemplateid = dltId;
  if (process.env.SMS_PEID) params.peid = process.env.SMS_PEID;
  if (process.env.SMS_TELEMARKETER_ID) params.telemarketerid = process.env.SMS_TELEMARKETER_ID;

  try {
    const res = await axios.get(url, { params, timeout: 20000 });
    const body = res.data;

    if (res.status < 200 || res.status >= 300) {
      logger.warn('SMS send: non-2xx HTTP status', { status: res.status });
      return { success: false, message: `HTTP ${res.status}`, providerResponse: body };
    }

    // Official success marker: ErrorCode "000" (or "0") with ErrorMessage "Done".
    const parsed = typeof body === 'string' ? tryParseJson(body) : body;
    const errorCode = parsed?.ErrorCode != null ? String(parsed.ErrorCode) : null;

    if (errorCode !== null) {
      const ok = errorCode === '000' || errorCode === '0';
      if (!ok) {
        logger.warn('SMS gateway returned an error', {
          errorCode,
          errorMessage: parsed?.ErrorMessage,
          number: mobile10.slice(-4),
        });
        return {
          success: false,
          message: parsed?.ErrorMessage || `ErrorCode ${errorCode}`,
          providerResponse: body,
        };
      }
      const md = Array.isArray(parsed?.MessageData) ? parsed.MessageData[0] : null;
      logger.info('SMS sent', { to: mobile10.slice(-4), jobId: parsed?.JobId, messageId: md?.MessageId });
      return { success: true, jobId: parsed?.JobId, messageId: md?.MessageId, providerResponse: body };
    }

    // No ErrorCode field — fall back to a conservative keyword check so we don't
    // report success on an unexpected error page.
    const asText = typeof body === 'string' ? body : JSON.stringify(body);
    const looksFailed = /error|invalid|fail|unauthori|denied|insufficient/i.test(asText) && !/success|done/i.test(asText);
    if (looksFailed) {
      logger.warn('SMS send: unrecognised failure response', { body: asText.slice(0, 200) });
      return { success: false, message: 'SMS gateway rejected the request', providerResponse: body };
    }
    logger.info('SMS sent (no ErrorCode in response)', { to: mobile10.slice(-4) });
    return { success: true, providerResponse: body };
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('SMS send failed', { detail: typeof detail === 'string' ? detail.slice(0, 200) : detail });
    return { success: false, message: err.message };
  }
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Send an OTP SMS. Text AND DLT template id both come from the editable SMS
 * config (kept in sync) → env → default, so changing the template also swaps its
 * matching DLT id.
 */
async function sendOtp(mobile10, otp) {
  const text = await otpMessage(otp);
  const dltTid = await dltTemplateId();
  return sendSms(mobile10, text, { dltTemplateId: dltTid });
}

module.exports = { sendSms, sendOtp, otpMessage, dltTemplateId };
