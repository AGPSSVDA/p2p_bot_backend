/**
 * SMS OTP config API — lets the admin edit the OTP text + its matching DLT
 * Template Id together (they must change as a pair). Other SMS params (sender id,
 * API key, PEID, route) stay in env.
 */

const smsConfigService = require('../services/smsConfigService');

// GET /api/seller/sms-config
const getSmsConfig = async (req, res) => {
  try {
    const cfg = await smsConfigService.getConfig();
    res.json({
      success: true,
      data: {
        otpTemplate: cfg.otpTemplate,
        dltTemplateId: cfg.dltTemplateId,
        // For the UI hint: what's currently effective (DB else env).
        effectiveDltTemplateId: cfg.effectiveDltTemplateId,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// PUT /api/seller/sms-config  { otpTemplate, dltTemplateId }
const updateSmsConfig = async (req, res) => {
  try {
    let otpTemplate = (req.body.otpTemplate ?? '').toString();
    const dltTemplateId = (req.body.dltTemplateId ?? '').toString().trim();

    // The admin may paste the DLT-approved text as-is, where the code slot is the
    // DLT variable "{#var#}". Accept that and normalise it to our {otp} token so
    // the sender fills it correctly. Both forms are valid input.
    if (otpTemplate.includes('{#var#}')) {
      otpTemplate = otpTemplate.replace(/\{#var#\}/g, '{otp}');
    }

    // Guard: after normalisation there must be a code slot, else no OTP is sent.
    if (otpTemplate && !otpTemplate.includes('{otp}')) {
      return res.status(400).json({
        success: false,
        error: 'OTP template must contain {otp} (or the DLT {#var#}) where the code goes.',
      });
    }

    await smsConfigService.setConfig({
      otpTemplate: otpTemplate || null,
      dltTemplateId: dltTemplateId || null,
    });

    res.json({ success: true, message: 'SMS config updated', data: { otpTemplate, dltTemplateId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { getSmsConfig, updateSmsConfig };
