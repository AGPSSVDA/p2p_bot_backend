const express = require("express");
const router = express.Router();
const {
  listOrders,
  getOrderByNo,
  cancelOrderManual,
  getLiveDetail,
  getStateEnum,
} = require("../controllers/ordersController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/orders:
 *   get:
 *     tags: [Orders]
 *     summary: List orders with pagination + filters
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - in: query
 *         name: status
 *         schema: { type: string, description: "state (comma-separated for multi)" }
 *       - in: query
 *         name: q
 *         schema: { type: string, description: "search order_no, seller_nickname, pan, pan_name" }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200: { description: Paginated list of orders }
 */
router.get("/", listOrders);

/**
 * @swagger
 * /api/orders/states:
 *   get:
 *     tags: [Orders]
 *     summary: Get the list of valid order states
 */
router.get("/states", getStateEnum);

/**
 * @swagger
 * /api/orders/{orderNo}/live:
 *   get:
 *     tags: [Orders]
 *     summary: Live order detail from Binance (bypasses DB cache)
 */
router.get("/:orderNo/live", getLiveDetail);

/**
 * @swagger
 * /api/orders/binance/{orderNo}:
 *   get:
 *     tags: [Orders]
 *     summary: Alias of /api/orders/{orderNo}/live — direct Binance passthrough
 */
router.get("/binance/:orderNo", getLiveDetail);

/**
 * @swagger
 * /api/orders/{orderNo}:
 *   get:
 *     tags: [Orders]
 *     summary: Get one order with state log + chat messages
 */
router.get("/:orderNo", getOrderByNo);

/**
 * @swagger
 * /api/orders/{orderNo}/cancel:
 *   post:
 *     tags: [Orders]
 *     summary: Manually cancel an order on Binance
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reasonCode: { type: integer, default: 6 }
 *               additionalInfo: { type: string }
 */
router.post("/:orderNo/cancel", cancelOrderManual);

module.exports = router;
