const express = require("express");
const router = express.Router();
const {
  getBotConfig,
  createBotConfig,
  updateBotConfig,
  deleteBotConfig
} = require("../controllers/botConfigController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * @swagger
 * /api/bot-config:
 *   get:
 *     tags: [Bot Config]
 *     summary: Get current bot configuration
 *     responses:
 *       200: { description: Current bot configuration }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 */
router.get("/", getBotConfig);

/**
 * @swagger
 * /api/bot-config:
 *   post:
 *     tags: [Bot Config]
 *     summary: Create a new bot configuration entry
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bot_status: { type: integer, enum: [0, 1], example: 1 }
 *               auto_payout: { type: integer, enum: [0, 1], example: 0 }
 *               bot_name: { type: string, example: P2P Trade Bot }
 *               logo: { type: string, example: https://example.com/logo.png }
 *     responses:
 *       200: { description: Bot configuration created }
 */
router.post("/", createBotConfig);

/**
 * @swagger
 * /api/bot-config/{id}:
 *   put:
 *     tags: [Bot Config]
 *     summary: Update an existing bot configuration entry
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
 *               bot_status: { type: integer, enum: [0, 1] }
 *               auto_payout: { type: integer, enum: [0, 1] }
 *               bot_name: { type: string }
 *               logo: { type: string }
 *     responses:
 *       200: { description: Bot configuration updated }
 *       404: { description: Configuration not found }
 */
router.put("/:id", updateBotConfig);

/**
 * @swagger
 * /api/bot-config/{id}:
 *   delete:
 *     tags: [Bot Config]
 *     summary: Delete a bot configuration entry
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Bot configuration deleted }
 *       404: { description: Configuration not found }
 */
router.delete("/:id", deleteBotConfig);

module.exports = router;
