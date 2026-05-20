const { pool } = require("../config/mysql");

// Get the most recent bot configuration (returns null if none exists)
async function getBotConfig() {
  const [rows] = await pool.query("SELECT * FROM bot_config ORDER BY id DESC LIMIT 1");
  return rows[0] || null;
}

// Tunable timer columns we accept on create/update. Each entry validates
// the input and clamps it to a sane range so the bot can't be misconfigured
// into states like "PAN timeout = 0".
const TUNABLES = {
  auto_cancel_buffer_ms: { min: 0,     max: 30 * 60 * 1000 },        // 0..30 min
  pan_timeout_ms:        { min: 60_000, max: 24 * 60 * 60 * 1000 },  // 1 min..24 h
  pan_reminder_ms:       { min: 0,     max: 24 * 60 * 60 * 1000 },   // 0..24 h
};

function coerceTunable(name, raw) {
  const cfg = TUNABLES[name];
  if (!cfg) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(n)));
}

// Create bot configuration
async function createBotConfig(data) {
  const { bot_status, auto_payout, bot_name, logo } = data;
  const [result] = await pool.query(
    `INSERT INTO bot_config
       (bot_status, auto_payout, bot_name, logo,
        auto_cancel_buffer_ms, pan_timeout_ms, pan_reminder_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      bot_status ? 1 : 0,
      auto_payout ? 1 : 0,
      bot_name || null,
      logo || null,
      coerceTunable('auto_cancel_buffer_ms', data.auto_cancel_buffer_ms) ?? 60000,
      coerceTunable('pan_timeout_ms',        data.pan_timeout_ms)        ?? 600000,
      coerceTunable('pan_reminder_ms',       data.pan_reminder_ms)       ?? 300000,
    ]
  );
  const [rows] = await pool.query("SELECT * FROM bot_config WHERE id = ?", [result.insertId]);
  return rows[0];
}

// Update bot configuration. Returns null if id not found or no fields supplied.
async function updateBotConfig(id, data) {
  const fields = [];
  const values = [];

  if (data.bot_status !== undefined) {
    fields.push("bot_status = ?");
    values.push(data.bot_status ? 1 : 0);
  }
  if (data.auto_payout !== undefined) {
    fields.push("auto_payout = ?");
    values.push(data.auto_payout ? 1 : 0);
  }
  if (data.bot_name !== undefined) {
    fields.push("bot_name = ?");
    values.push(data.bot_name);
  }
  if (data.logo !== undefined) {
    fields.push("logo = ?");
    values.push(data.logo);
  }
  for (const name of Object.keys(TUNABLES)) {
    if (data[name] !== undefined) {
      const coerced = coerceTunable(name, data[name]);
      if (coerced !== undefined) {
        fields.push(`${name} = ?`);
        values.push(coerced);
      }
    }
  }

  if (fields.length === 0) return null;

  values.push(id);
  const [result] = await pool.query(
    `UPDATE bot_config SET ${fields.join(", ")} WHERE id = ?`,
    values
  );
  if (result.affectedRows === 0) return null;

  const [rows] = await pool.query("SELECT * FROM bot_config WHERE id = ?", [id]);
  return rows[0] || null;
}

// Delete bot configuration
async function deleteBotConfig(id) {
  const [result] = await pool.query("DELETE FROM bot_config WHERE id = ?", [id]);
  return result;
}

module.exports = {
  getBotConfig,
  createBotConfig,
  updateBotConfig,
  deleteBotConfig
};
