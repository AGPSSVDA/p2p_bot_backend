const express = require("express");
const router = express.Router();
const { listTds, exportTds } = require("../controllers/tdsController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/tds:
 *   get:
 *     tags: [TDS]
 *     summary: Get TDS records with optional period filter
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: [ALL, MONTH, QUARTER, YEAR, CUSTOM] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 */
router.get("/", listTds);

/**
 * @swagger
 * /api/tds/export:
 *   get:
 *     tags: [TDS]
 *     summary: Export TDS records as Excel
 */
router.get("/export", exportTds);

module.exports = router;
