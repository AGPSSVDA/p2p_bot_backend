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

  // POST /api/seller/openai/credit   body: { creditAdded: number }
  async setCredit(req, res) {
    try {
      const amount = await openaiUsage.setCreditAdded(req.body?.creditAdded);
      return res.json({ success: true, creditAdded: amount });
    } catch (error) {
      logger.error(`OpenAI set credit error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = new OpenaiUsageController();
