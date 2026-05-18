const express = require("express");
const router = express.Router();
const { getOverview, getDailySeries } = require("../controllers/overviewController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/overview:
 *   get:
 *     tags: [Overview]
 *     summary: Aggregated KPIs for the dashboard overview page
 *     responses:
 *       200: { description: KPI totals (orders today/month, volume, crypto, success rate, etc.) }
 *       401: { description: Unauthorized }
 */
router.get("/", getOverview);

/**
 * @swagger
 * /api/overview/daily:
 *   get:
 *     tags: [Overview]
 *     summary: Daily time-series for charts
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30 }
 *     responses:
 *       200: { description: Daily orders / completed / volume / crypto for the last N days }
 */
router.get("/daily", getDailySeries);

module.exports = router;
