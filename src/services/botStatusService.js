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

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [rows] = await pool.query(
        "SELECT bot_status, auto_payout FROM bot_config ORDER BY id ASC LIMIT 1"
      );
      cachedStatus = rows[0] || { bot_status: 0, auto_payout: 0 };
      cachedAt = Date.now();
    } catch (err) {
      logger.warn("botStatus refresh failed", { error: err.message });
      // Fail-safe: if we can't read, treat as ON to avoid silently dropping
      // messages during DB outage (operator can disable network if needed).
      cachedStatus = { bot_status: 1, auto_payout: 0 };
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

function invalidate() {
  cachedStatus = null;
  cachedAt = 0;
}

module.exports = {
  getStatus,
  isBotEnabled,
  isAutoPayoutEnabled,
  invalidate,
};
