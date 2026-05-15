// ─────────────────────────────────────────────────────────────────────────────
//  Binance P2P Automation Bot — SAPI v7.4
//  Entry Point
// ─────────────────────────────────────────────────────────────────────────────

const { validateConfig }    = require('./config/config');
const { orderPoller }       = require('./bot/orderPoller');
const { chatService }       = require('./services/chatService');
const { stateManager }      = require('./bot/stateManager');
const { syncBinanceTime }   = require('./utils/helpers');
const { startDashboard }    = require('./dashboard/server');
const logger                = require('./utils/logger');

const express = require("express");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const path = require("path");
// const binanceConfig = require("./config/binance"); // TODO: file not created yet
const { getDb, closeDb } = require("./config/database");
// const { initSocket } = require("./services/socketService"); // TODO: file not created yet
// const orderRoutes = require("./routes/orderRoutes"); // TODO: file not created yet
// const chatRoutes = require("./routes/chatRoutes"); // TODO: file not created yet
// const adminRoutes = require("./routes/adminRoutes"); // TODO: file not created yet
const templateRoutes = require("./routes/templateRoutes");
const payoutRoutes = require("./routes/payoutRoutes");
const authRoutes = require("./routes/authRoutes");
const botConfigRoutes = require("./routes/botConfigRoutes");
const { initMysql } = require("./config/mysql");
// const { auditLog } = require("./utils/logger"); // TODO: logger does not export auditLog
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const { swaggerSpec } = require("./config/swagger");

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: ["http://localhost:8080", "http://localhost:3000","http://192.168.1.69:8080", "http://192.168.1.69:3000"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: ["http://localhost:8080", "http://localhost:3000","http://192.168.1.69:8080", "http://192.168.1.69:3000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── API Docs (Swagger UI) ──
app.get("/openapi.json", (req, res) => res.json(swaggerSpec));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: "P2P Binance Backend API",
  swaggerOptions: { persistAuthorization: true },
}));

// ── Routes ──
app.use("/api/auth", authRoutes);
// app.use("/api/orders", orderRoutes); // TODO: enable when ./routes/orderRoutes is created
// app.use("/api/chat", chatRoutes);    // TODO: enable when ./routes/chatRoutes is created
// app.use("/api/admin", adminRoutes);  // TODO: enable when ./routes/adminRoutes is created
app.use("/api/templates", templateRoutes);
app.use("/api/payouts", payoutRoutes);
app.use("/api/bot-config", botConfigRoutes);


// ── Step 1: Validate config (.env) ────────────────────────────────────────────
validateConfig();

// ── Step 2: Start ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║      Binance P2P Bot  —  SAPI v7.4  —  Starting     ║');
  logger.info('╚══════════════════════════════════════════════════════╝');

  // Initialize databases (SQLite + MySQL) before anything else runs
  await getDb();
  await initMysql();

  // Sync clock with Binance BEFORE any signed request — fixes -1021 errors
  await syncBinanceTime();
  // Re-sync every 5 minutes to handle slow drift
  setInterval(() => syncBinanceTime().catch(() => {}), 5 * 60 * 1000);

  // Start order poller (detects new orders + fallback chat polling)
  orderPoller.start();

  // Stats every 2 minutes
  setInterval(() => stateManager.printStats(), 2 * 60 * 1000);

  // Start manual-cancel-test dashboard
  const dashPort = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;
  startDashboard(dashPort);

  // Start main API + Socket.IO server (auth, templates, payouts, bot-config)
  const apiPort = parseInt(process.env.API_PORT, 10) || 4000;
  server.listen(apiPort, () => {
    logger.info(`🌐 API server listening on http://localhost:${apiPort}`);
    logger.info(`📚 API docs available at http://localhost:${apiPort}/docs`);
  });

  logger.info('✅ Bot is running. Waiting for new P2P orders...\n');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`\n${signal} received — shutting down...`);
  orderPoller.stop();
  chatService.disconnectAll();
  stateManager.printStats();
  try { await closeDb(); } catch (_) {}
  logger.info('Bye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Crash handlers ────────────────────────────────────────────────────────────
process.on('uncaughtException', async (err) => {
  logger.error('UNCAUGHT EXCEPTION', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error('UNHANDLED REJECTION', { reason: String(reason) });
});

// ── Go! ───────────────────────────────────────────────────────────────────────
main();
