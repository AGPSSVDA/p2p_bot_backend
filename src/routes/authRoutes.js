const express = require("express");
const router = express.Router();
const { login, logout, changePassword } = require("../controllers/authController");
const { authMiddleware, verifyTokenOnly } = require("../middleware/authMiddleware");

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Login with email and password
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: admin@gmail.com }
 *               password: { type: string, example: admin123 }
 *     responses:
 *       200:
 *         description: Returns JWT token and user info
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         token: { type: string }
 *                         user:
 *                           type: object
 *                           properties:
 *                             id: { type: integer }
 *                             email: { type: string }
 *                             role: { type: string, enum: [admin, user] }
 *       400: { description: Missing email or password }
 *       401: { description: Invalid credentials }
 */
router.post("/login", login);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Authentication]
 *     summary: Logout current session (invalidates JWT)
 *     responses:
 *       200: { description: Logged out successfully }
 *       401: { description: Token missing or invalid }
 */
router.post("/logout", verifyTokenOnly, logout);

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     tags: [Authentication]
 *     summary: Change password for the logged-in user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               oldPassword: { type: string }
 *               newPassword: { type: string }
 *     responses:
 *       200: { description: Password updated successfully }
 *       400: { description: Missing fields }
 *       401: { description: Incorrect old password }
 */
router.post("/change-password", authMiddleware, changePassword);

module.exports = router;
