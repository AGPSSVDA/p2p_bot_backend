const { pool } = require("../config/mysql");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  messageService — DB-driven chat templates
//
//  Every outbound bot message resolves to a template_key in the
//  template_groups/template_messages tables. Admin can edit these from the
//  Chat Templates page; this service is the single read path used by the bot.
//
//  Cache:
//    Templates are cached in-memory for 30 seconds to avoid hitting MySQL on
//    every chat send. Editing a template from the UI takes effect within ~30s.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cache = null;          // { key: { texts: [string], updatedAt: ms } }
let cacheLoadedAt = 0;
let inflightLoad = null;

async function loadCache() {
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      const [rows] = await pool.query(`
        SELECT g.template_key, m.message_text, m.step_order
        FROM template_groups g
        LEFT JOIN template_messages m ON g.id = m.template_id
        ORDER BY g.template_key ASC, m.step_order ASC
      `);
      const next = {};
      for (const r of rows) {
        if (!r.template_key) continue;
        if (!next[r.template_key]) next[r.template_key] = { texts: [] };
        if (r.message_text) next[r.template_key].texts.push(r.message_text);
      }
      cache = next;
      cacheLoadedAt = Date.now();
    } catch (err) {
      logger.error("Failed to load message templates from DB", { error: err.message });
      if (!cache) cache = {};
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

async function ensureCache() {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    await loadCache();
  }
}

function fill(template, vars) {
  if (!template) return "";
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (out, [k, v]) =>
      out.replace(new RegExp(`\\{${k}\\}`, "g"), v == null ? "" : String(v)),
    template
  );
}

// ── Return the first message text for a template key, or empty string ────────
async function get(key, vars) {
  await ensureCache();
  const entry = cache?.[key];
  if (!entry || entry.texts.length === 0) {
    logger.warn("Template missing in DB", { key });
    return "";
  }
  return fill(entry.texts[0], vars);
}

// ── Return every message text for a key (multi-step templates) ───────────────
async function getAll(key, vars) {
  await ensureCache();
  const entry = cache?.[key];
  if (!entry || entry.texts.length === 0) {
    logger.warn("Template missing in DB", { key });
    return [];
  }
  return entry.texts.map((t) => fill(t, vars));
}

function invalidate() {
  cache = null;
  cacheLoadedAt = 0;
}

// ── Format INR with locale-aware grouping (templates render the raw number) ──
function inr(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// ── Compute the TDS_INFO quarter/credit/visible placeholders ─────────────────
function tdsInfoVars(tds) {
  const now = new Date();
  const currYear = now.getFullYear();
  const quarter = Math.ceil((now.getMonth() + 1) / 3);
  const quarters = [
    ["Jan–Mar", "Apr", "May"],
    ["Apr–Jun", "Jul", "Aug"],
    ["Jul–Sep", "Oct", "Nov"],
    ["Oct–Dec", "Jan", "Feb"],
  ];
  const [currQ, creditM, visibleM] = quarters[quarter - 1];
  return {
    tds: inr(tds?.tds),
    quarter: currQ,
    year: currYear,
    creditMonth: creditM,
    visibleMonth: visibleM,
  };
}

module.exports = {
  get,
  getAll,
  invalidate,
  fill,
  inr,
  tdsInfoVars,
};
