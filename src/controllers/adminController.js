const { pool } = require("../config/mysql");
const messageService = require("../services/messageService");
const botStatusService = require("../services/botStatusService");
const binanceSync = require("../services/binanceSyncService");
const logger = require("../utils/logger");

// Tables that are safe to truncate (do NOT include users — would lock you out)
const RESETTABLE = {
  orders:           "TRUNCATE TABLE orders",
  order_state_log:  "TRUNCATE TABLE order_state_log",
  order_messages:   "TRUNCATE TABLE order_messages",
  ads:              "TRUNCATE TABLE ads",
  payouts:          "TRUNCATE TABLE payouts",
};

// ── POST /api/admin/reset ────────────────────────────────────────────────────
//   Body: { tables: ["orders", "payouts", ...], confirm: "YES" }
//   Requires admin role. Truncates the requested whitelisted tables.
async function reset(req, res) {
  try {
    if (req.body.confirm !== "YES") {
      return res.status(400).json({
        success: false,
        message: "Refusing to reset — pass { confirm: 'YES' } in the body",
        data: null,
      });
    }

    const requested = Array.isArray(req.body.tables) && req.body.tables.length
      ? req.body.tables
      : Object.keys(RESETTABLE);

    const unknown = requested.filter((t) => !RESETTABLE[t]);
    if (unknown.length) {
      return res.status(400).json({
        success: false,
        message: `Unknown tables: ${unknown.join(", ")}. Allowed: ${Object.keys(RESETTABLE).join(", ")}`,
        data: null,
      });
    }

    await pool.query("SET FOREIGN_KEY_CHECKS = 0");
    const wiped = [];
    for (const t of requested) {
      await pool.query(RESETTABLE[t]);
      wiped.push(t);
      logger.warn(`Admin RESET — truncated ${t}`, { user: req.user?.email });
    }
    await pool.query("SET FOREIGN_KEY_CHECKS = 1");

    messageService.invalidate();
    botStatusService.invalidate();

    res.json({
      success: true,
      message: `Truncated ${wiped.length} table(s)`,
      data: { wiped },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── GET /api/admin/health ────────────────────────────────────────────────────
async function health(req, res) {
  try {
    const [r] = await pool.query("SELECT 1 AS ok");
    res.json({
      success: true,
      message: "OK",
      data: { db: r[0]?.ok === 1, time: new Date().toISOString() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── POST /api/admin/sync-binance-orders ──────────────────────────────────────
//   Body: { statuses?: number[], maxPages?: number, rowsPerPage?: number }
//   Defaults to all statuses (1,2,3,4,6,7), maxPages=10, rowsPerPage=50.
//   Idempotent — calling it twice produces the same DB state.
async function syncBinanceOrders(req, res) {
  try {
    const statuses = Array.isArray(req.body.statuses) && req.body.statuses.length
      ? req.body.statuses
      : undefined;
    const maxPages = Math.min(Math.max(parseInt(req.body.maxPages, 10) || 10, 1), 100);
    const rowsPerPage = Math.min(Math.max(parseInt(req.body.rowsPerPage, 10) || 50, 10), 100);

    logger.warn("Admin SYNC binance-orders started", {
      user: req.user?.email, statuses, maxPages, rowsPerPage,
    });

    const result = await binanceSync.sync(statuses, { maxPages, rowsPerPage });

    res.json({
      success: true,
      message: `Synced ${result.total} order(s) from Binance`,
      data: result,
    });
  } catch (err) {
    logger.error("Admin SYNC failed", { error: err.message });
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { reset, health, syncBinanceOrders };
