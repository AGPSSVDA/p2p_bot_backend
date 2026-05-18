const express = require("express");
const router = express.Router();
const { listAds } = require("../controllers/adsController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);

/**
 * @swagger
 * /api/ads:
 *   get:
 *     tags: [Ads]
 *     summary: List the merchant's ads with order-level aggregations
 *     responses:
 *       200: { description: Summary tiles + per-ad stats }
 *       401: { description: Unauthorized }
 */
router.get("/", listAds);

module.exports = router;
