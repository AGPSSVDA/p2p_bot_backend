const logger = require('../../utils/logger');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const { getSellerIdFromRequest } = require('../utils/sellerUtils');

class SellerTradeTypesController {

  /**
   * GET /api/seller/trade-types
   * Get all custom trade types for seller
   */
  async getTradeTypes(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching trade types', { sellerId });

      const tradeTypes = await sellerOrderDbService.getTradeTypes(sellerId);

      // Add default options at the beginning
      const allTradeTypes = [
        { id: 0, trade_type_name: 'ANY' },
        { id: -1, trade_type_name: 'BUY' },
        { id: -2, trade_type_name: 'SELL' },
        ...tradeTypes
      ];

      res.status(200).json({
        success: true,
        data: allTradeTypes
      });

    } catch (error) {
      logger.error(`Get trade types error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /api/seller/trade-types
   * Create new custom trade type
   */
  async createTradeType(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { tradeTypeName } = req.body;

      if (!tradeTypeName || tradeTypeName.trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'Trade type name is required'
        });
      }

      logger.info('Creating trade type', { sellerId, tradeTypeName });

      await sellerOrderDbService.createTradeType(sellerId, tradeTypeName);

      logger.info(`✅ Trade type created`, { sellerId, tradeTypeName });

      res.status(201).json({
        success: true,
        message: 'Trade type created successfully',
        data: {
          trade_type_name: tradeTypeName
        }
      });

    } catch (error) {
      logger.error(`Create trade type error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * DELETE /api/seller/trade-types/:tradeTypeName
   * Delete custom trade type
   */
  async deleteTradeType(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { tradeTypeName } = req.params;

      logger.info('Deleting trade type', { sellerId, tradeTypeName });

      await sellerOrderDbService.deleteTradeType(sellerId, tradeTypeName);

      logger.info(`✅ Trade type deleted`, { sellerId, tradeTypeName });

      res.status(200).json({
        success: true,
        message: 'Trade type deleted successfully'
      });

    } catch (error) {
      logger.error(`Delete trade type error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new SellerTradeTypesController();
