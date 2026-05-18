const express = require("express");
const router = express.Router();
const { listPayments, approvePayment } = require("../controllers/paymentsController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/payments:
 *   get:
 *     tags: [Payments]
 *     summary: List payments / payouts with summary tiles
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [SUCCESS, PENDING, FAILED] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200: { description: Payment list + summary tiles + autoPayout flag }
 */
router.get("/", listPayments);

/**
 * @swagger
 * /api/payments/{id}/approve:
 *   post:
 *     tags: [Payments]
 *     summary: Manually approve a PENDING payment with UTR
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               utr: { type: string }
 */
router.post("/:id/approve", approvePayment);

module.exports = router;
