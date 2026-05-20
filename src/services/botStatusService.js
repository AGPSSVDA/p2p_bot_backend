const { pool } = require("../config/mysql");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  botStatusService — cached read of bot_config.bot_status
//
//  When bot_status = 0 (OFF), chatService skips outbound messages — the
//  poller keeps detecting orders and persisting them, but the bot stays
//  silent until the toggle is flipped back on.
//
//  Cache TTL is short (3s) so the OFF/ON toggle takes effect almost
//  immediately without thrashing the DB.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 3_000;
let cachedStatus = null;
let cachedAt = 0;
let inflight = null;

// Defaults if bot_config row is missing or DB read fails.
const DEFAULTS = {
  bot_status: 0,
  auto_payout: 0,
  auto_cancel_buffer_ms: 60000,
  pan_timeout_ms: 600000,
  pan_reminder_ms: 300000,
};

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [rows] = await pool.query(
        `SELECT bot_status, auto_payout,
                auto_cancel_buffer_ms, pan_timeout_ms, pan_reminder_ms
         FROM bot_config ORDER BY id ASC LIMIT 1`
      );
      cachedStatus = rows[0] ? { ...DEFAULTS, ...rows[0] } : { ...DEFAULTS };
      cachedAt = Date.now();
    } catch (err) {
      logger.warn("botStatus refresh failed", { error: err.message });
      // Fail-safe: if we can't read, treat bot as ON to avoid silently
      // dropping messages during DB outage; tunables use safe defaults.
      cachedStatus = { ...DEFAULTS, bot_status: 1 };
      cachedAt = Date.now();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function getStatus() {
  if (!cachedStatus || Date.now() - cachedAt > CACHE_TTL_MS) {
    await refresh();
  }
  return cachedStatus;
}

async function isBotEnabled() {
  const s = await getStatus();
  return Number(s?.bot_status) === 1;
}

async function isAutoPayoutEnabled() {
  const s = await getStatus();
  return Number(s?.auto_payout) === 1;
}

async function getAutoCancelBufferMs() {
  const s = await getStatus();
  const v = Number(s?.auto_cancel_buffer_ms);
  return Number.isFinite(v) ? v : DEFAULTS.auto_cancel_buffer_ms;
}

async function getPanTimeoutMs() {
  const s = await getStatus();
  const v = Number(s?.pan_timeout_ms);
  return Number.isFinite(v) ? v : DEFAULTS.pan_timeout_ms;
}

async function getPanReminderMs() {
  const s = await getStatus();
  const v = Number(s?.pan_reminder_ms);
  return Number.isFinite(v) ? v : DEFAULTS.pan_reminder_ms;
}

function invalidate() {
  cachedStatus = null;
  cachedAt = 0;
}

module.exports = {
  getStatus,
  isBotEnabled,
  isAutoPayoutEnabled,
  getAutoCancelBufferMs,
  getPanTimeoutMs,
  getPanReminderMs,
  invalidate,
};
