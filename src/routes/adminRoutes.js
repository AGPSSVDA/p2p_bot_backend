const express = require("express");
const router = express.Router();
const { reset, health } = require("../controllers/adminController");
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

module.exports = router;
