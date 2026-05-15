const express = require("express");
const router = express.Router();
const { getPayouts, seedPayouts, exportPayouts } = require("../controllers/payoutController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * @swagger
 * /api/payouts:
 *   get:
 *     tags: [Payouts]
 *     summary: List all payouts
 *     responses:
 *       200: { description: Array of payout records }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 */
router.get("/", getPayouts);

/**
 * @swagger
 * /api/payouts/seed:
 *   post:
 *     tags: [Payouts]
 *     summary: Seed the payouts table with sample/test data
 *     responses:
 *       200: { description: Seed rows inserted }
 */
router.post("/seed", seedPayouts);

/**
 * @swagger
 * /api/payouts/export:
 *   get:
 *     tags: [Payouts]
 *     summary: Export payouts as an Excel (.xlsx) file
 *     responses:
 *       200:
 *         description: Excel file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema: { type: string, format: binary }
 */
router.get("/export", exportPayouts);

module.exports = router;
