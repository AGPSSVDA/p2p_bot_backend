const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');

// Controllers
const sellerAdsController = require('../controllers/sellerAdsController');
const sellerOrdersController = require('../controllers/sellerOrdersController');
const sellerDashboardController = require('../controllers/sellerDashboardController');
const sellerSyncController = require('../controllers/sellerSyncController');
const sellerTradeTypesController = require('../controllers/sellerTradeTypesController');

// Middleware
const { authMiddleware } = require('../../middleware/authMiddleware'); // Assuming you have auth middleware

/**
 * All routes require authentication
 */
router.use(authMiddleware);

// Logging middleware
router.use((req, res, next) => {
  logger.info(`[SELLER API] ${req.method} ${req.path}`, {
    sellerId: req.user?.id,
    userId: req.user?.userId
  });
  next();
});

/**
 * ===== DASHBOARD ENDPOINTS =====
 */

// GET /api/seller/dashboard
router.get('/dashboard', (req, res) => sellerDashboardController.getDashboard(req, res));

// GET /api/seller/dashboard/health
router.get('/dashboard/health', (req, res) => sellerDashboardController.getHealthMetrics(req, res));

// GET /api/seller/dashboard/activity
router.get('/dashboard/activity', (req, res) => sellerDashboardController.getActivityLog(req, res));

/**
 * ===== AD MANAGEMENT ENDPOINTS =====
 */

// GET /api/seller/ads
router.get('/ads', (req, res) => sellerAdsController.getAds(req, res));

// GET /api/seller/ads/:adNo
router.get('/ads/:adNo', (req, res) => sellerAdsController.getAdDetail(req, res));

// PUT /api/seller/ads/:adNo/rules
router.put('/ads/:adNo/rules', (req, res) => sellerAdsController.updateAdRules(req, res));

// POST /api/seller/ads/:adNo/sync-eligibility
// ELIGIBILITY ONLY -> syncs buyer-eligibility criteria to the Binance ad, then saves to DB.
// Does NOT touch verification methods (see /methods below).
router.post('/ads/:adNo/sync-eligibility', (req, res) => sellerAdsController.syncEligibilityToBinance(req, res));

// PUT /api/seller/ads/:adNo/methods
// METHODS ONLY -> saves verification method toggles (Method 1/2/3) to our DB.
// These are bot-side behaviour applied AFTER an order arrives; Binance has no
// concept of them, so this never calls the Binance API.
router.put('/ads/:adNo/methods', (req, res) => sellerAdsController.updateAdMethods(req, res));

// POST /api/seller/ads/:adNo/toggle
router.post('/ads/:adNo/toggle', (req, res) => sellerAdsController.toggleAd(req, res));

/**
 * ===== ORDER MANAGEMENT ENDPOINTS =====
 */

// GET /api/seller/orders
router.get('/orders', (req, res) => sellerOrdersController.getOrders(req, res));

// GET /api/seller/orders/stats/summary
router.get('/orders/stats/summary', (req, res) => sellerOrdersController.getOrderStats(req, res));

// GET /api/seller/orders/:orderNo
router.get('/orders/:orderNo', (req, res) => sellerOrdersController.getOrderDetail(req, res));

// GET /api/seller/orders/timeline/:orderNo
router.get('/orders/timeline/:orderNo', (req, res) => sellerOrdersController.getOrderTimeline(req, res));

// GET /api/seller/orders/:orderNo/eligibility-check
router.get('/orders/:orderNo/eligibility-check', (req, res) => sellerOrdersController.getEligibilityCheckDetails(req, res));

/**
 * ===== SYNC ENDPOINTS =====
 */

// POST /api/seller/sync/ads
router.post('/sync/ads', (req, res) => sellerSyncController.syncAdsFromBinance(req, res));

// GET /api/seller/sync/status
router.get('/sync/status', (req, res) => sellerSyncController.getSyncStatus(req, res));

/**
 * ===== TRADE TYPES ENDPOINTS =====
 */

// GET /api/seller/trade-types
router.get('/trade-types', (req, res) => sellerTradeTypesController.getTradeTypes(req, res));

// POST /api/seller/trade-types
router.post('/trade-types', (req, res) => sellerTradeTypesController.createTradeType(req, res));

// DELETE /api/seller/trade-types/:tradeTypeName
router.delete('/trade-types/:tradeTypeName', (req, res) => sellerTradeTypesController.deleteTradeType(req, res));

/**
 * Error handling middleware for seller routes
 */
router.use((err, req, res, next) => {
  logger.error(`Seller API error: ${err.message}`, {
    path: req.path,
    method: req.method,
    error: err
  });

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

module.exports = router;
