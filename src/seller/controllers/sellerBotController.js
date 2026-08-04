const logger = require('../../utils/logger');
const sellerOrderPoller = require('../bot/sellerOrderPoller');
const sellerOrderDbService = require('../services/sellerOrderDbService');

/**
 * Seller bot on/off control. The on/off state is PERSISTED in the DB
 * (seller_bot_config.bot_status), so a stop survives a server restart:
 * on startup the poller reads the flag and only starts if it's 1.
 *
 * stop() halts new-order polling AND clears every in-flight liveness/document/
 * payment loop immediately. start() resumes polling (and recovers stuck orders).
 */
class SellerBotController {
  // GET /api/seller/bot/status
  async status(req, res) {
    const persisted = await sellerOrderDbService.isSellerBotEnabled();
    return res.json({
      success: true,
      running: sellerOrderPoller.isRunning(),
      enabled: persisted, // the persisted intent (survives restart)
    });
  }

  // POST /api/seller/bot/stop
  async stop(req, res) {
    try {
      await sellerOrderDbService.setSellerBotEnabled(false); // persist first
      if (sellerOrderPoller.isRunning()) {
        sellerOrderPoller.stop();
      }
      logger.info('Seller bot STOPPED via API (persisted)');
      return res.json({ success: true, running: false, message: 'Seller bot stopped' });
    } catch (error) {
      logger.error(`Seller bot stop error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // POST /api/seller/bot/start
  async start(req, res) {
    try {
      await sellerOrderDbService.setSellerBotEnabled(true); // persist first
      if (!sellerOrderPoller.isRunning()) {
        sellerOrderPoller.start();
      }
      logger.info('Seller bot STARTED via API (persisted)');
      return res.json({ success: true, running: true, message: 'Seller bot started' });
    } catch (error) {
      logger.error(`Seller bot start error: ${error.message}`, { error });
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = new SellerBotController();
