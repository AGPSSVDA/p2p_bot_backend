const express = require("express");
const router = express.Router();
const {
  listAssets,
  addAsset,
  updateAsset,
  deleteAsset,
  listHistory,
} = require("../controllers/convertController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/convert/assets:
 *   get:
 *     tags: [Convert]
 *     summary: List target coins for the auto-convert dropdown
 *     parameters:
 *       - in: query
 *         name: enabled
 *         schema: { type: boolean }
 *         description: When true, returns only enabled symbols
 */
router.get("/assets", listAssets);

/**
 * @swagger
 * /api/convert/history:
 *   get:
 *     tags: [Convert]
 *     summary: Paginated conversion history
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [SUCCESS, PENDING, FAILED, SKIPPED] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 */
router.get("/history", listHistory);

// Admin-only mutations to the dropdown list
router.use(adminMiddleware);

/**
 * @swagger
 * /api/convert/assets:
 *   post:
 *     tags: [Convert]
 *     summary: Add a new target coin to the dropdown
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symbol]
 *             properties:
 *               symbol:     { type: string, example: BUSD }
 *               name:       { type: string, example: "Binance USD" }
 *               sort_order: { type: integer }
 */
router.post("/assets", addAsset);

/**
 * @swagger
 * /api/convert/assets/{symbol}:
 *   patch:
 *     tags: [Convert]
 *     summary: Update a target coin (rename, enable/disable, reorder)
 */
router.patch("/assets/:symbol", updateAsset);

/**
 * @swagger
 * /api/convert/assets/{symbol}:
 *   delete:
 *     tags: [Convert]
 *     summary: Remove a target coin from the dropdown
 */
router.delete("/assets/:symbol", deleteAsset);

module.exports = router;
