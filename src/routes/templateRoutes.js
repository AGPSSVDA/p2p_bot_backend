const express = require("express");
const router = express.Router();
const {
  createTemplate,
  getTemplates,
  getTemplateByKey,
  updateTemplate,
  deleteTemplate,
  deleteTemplateGroup
} = require("../controllers/templateController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * @swagger
 * /api/templates:
 *   post:
 *     tags: [Templates]
 *     summary: Create a template group with messages (or append messages to an existing key)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [template_key, messages]
 *             properties:
 *               template_key: { type: string, example: starting_message }
 *               small_description: { type: string }
 *               sort_order: { type: integer }
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [message_text]
 *                   properties:
 *                     message_text: { type: string }
 *                     step_order: { type: integer }
 *     responses:
 *       200: { description: Template created or messages appended }
 *       400: { description: Missing template_key or messages array }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 */
router.post("/", createTemplate);

/**
 * @swagger
 * /api/templates:
 *   get:
 *     tags: [Templates]
 *     summary: List all template groups with their messages
 *     responses:
 *       200: { description: List of template groups }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 */
router.get("/", getTemplates);

/**
 * @swagger
 * /api/templates/{key}:
 *   get:
 *     tags: [Templates]
 *     summary: Get a template group by its key
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *         example: pan_card_want
 *     responses:
 *       200: { description: Template group with messages }
 *       404: { description: Template not found }
 */
router.get("/:key", getTemplateByKey);

/**
 * @swagger
 * /api/templates:
 *   put:
 *     tags: [Templates]
 *     summary: Update a template message or group metadata
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id: { type: integer, description: "template_messages.id to update" }
 *               message_text: { type: string }
 *               step_order: { type: integer }
 *               group_id: { type: integer, description: "template_groups.id to update group fields" }
 *               small_description: { type: string }
 *               sort_order: { type: integer }
 *     responses:
 *       200: { description: Template updated }
 *       400: { description: Invalid payload }
 *       404: { description: Template not found }
 */
router.put("/", updateTemplate);

/**
 * @swagger
 * /api/templates/{id}:
 *   delete:
 *     tags: [Templates]
 *     summary: Delete a single template message by its id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Message deleted }
 *       404: { description: Message not found }
 */
router.delete("/:id", deleteTemplate);

/**
 * @swagger
 * /api/templates/group/{id}:
 *   delete:
 *     tags: [Templates]
 *     summary: Delete an entire template group and its messages
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Template group deleted }
 *       404: { description: Group not found }
 */
router.delete("/group/:id", deleteTemplateGroup);

module.exports = router;
