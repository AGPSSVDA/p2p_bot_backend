const logger = require('../../utils/logger');
const openaiUsage = require('../services/openaiUsageService');

/**
 * OpenAI usage / credit endpoints for the admin Settings page.
 */
class OpenaiUsageController {
  // GET /api/seller/openai/usage
  async summary(req, res) {
    try {
      const data = await openaiUsage.getSummary();
      return res.json({ success: true, data });
    } catch (error) {
      logger.error(`OpenAI usage summary error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // Credit is now set via env OPENAI_CREDIT_USD, not the frontend. The old
  // POST /api/seller/openai/credit endpoint has been removed.
}

module.exports = new OpenaiUsageController();
