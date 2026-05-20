const express = require("express");
const router = express.Router();
const { reset, health, syncBinanceOrders } = require("../controllers/adminController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

/**
 * @swagger
 * /api/admin/health:
 *   get:
 *     tags: [Admin]
 *     summary: Health check (DB ping)
 */
router.get("/health", health);

router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * @swagger
 * /api/admin/reset:
 *   post:
 *     tags: [Admin]
 *     summary: Truncate transactional tables (orders/state_log/messages/ads/payouts)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirm]
 *             properties:
 *               confirm:
 *                 type: string
 *                 enum: [YES]
 *               tables:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [orders, order_state_log, order_messages, ads, payouts]
 */
router.post("/reset", reset);

/**
 * @swagger
 * /api/admin/sync-binance-orders:
 *   post:
 *     tags: [Admin]
 *     summary: Backfill orders from Binance into the local DB
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               statuses:
 *                 type: array
 *                 description: "Order status codes to sync. Default = [1,2,3,4,6,7]"
 *                 items: { type: integer }
 *               maxPages:    { type: integer, default: 10, maximum: 100 }
 *               rowsPerPage: { type: integer, default: 50, maximum: 100 }
 */
router.post("/sync-binance-orders", syncBinanceOrders);

module.exports = router;
