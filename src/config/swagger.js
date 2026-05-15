const swaggerJsdoc = require("swagger-jsdoc");
const path = require("path");

const apiPort = parseInt(process.env.API_PORT, 10) || 5000;

const options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "P2P Binance Backend API",
      version: "1.0.0",
      description:
        "Backend API for the Binance P2P automation bot. Use `/api/auth/login` to obtain a JWT and authorize subsequent requests.",
    },
    servers: [
      { url: `http://localhost:${apiPort}`, description: "Local dev" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        ApiResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            message: { type: "string" },
            data: { nullable: true },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Authentication", description: "Login, logout, password change" },
      { name: "Templates", description: "Bot message templates" },
      { name: "Payouts", description: "Payout history and exports" },
      { name: "Bot Config", description: "Bot configuration management" },
    ],
  },
  apis: [path.join(__dirname, "..", "routes", "*.js")],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec };
