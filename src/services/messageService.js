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

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL TEMPLATE VARIABLES
//
//  Every variable below is available in EVERY template. The bot fills them
//  from the live order state on each send (see orderHandler._buildVars), so an
//  admin can use {pan}, {utr}, {tds}, etc. in ANY template — welcome, thankYou,
//  paymentSent, a custom one — and it will be replaced with the real value.
//
//  The frontend "Chat Templates" page reads this list (GET
//  /api/templates/variables) to show a clickable variable palette. Keep the
//  names here in exact sync with the keys produced by orderHandler._buildVars.
// ─────────────────────────────────────────────────────────────────────────────
const TEMPLATE_VARIABLES = [
  // Identity
  { name: "sellerName",      example: "RAHUL SHARMA",        description: "Seller's Binance KYC / real name" },
  { name: "sellerNickname",  example: "rahul_p2p",           description: "Seller's Binance public nickname" },
  { name: "kycName",         example: "RAHUL SHARMA",        description: "Seller's KYC name (falls back to nickname)" },
  { name: "orderNo",         example: "22899…1772416",       description: "Binance order number" },
  { name: "previousOrderNo", example: "22891…5171772",       description: "Returning seller's previous completed order number" },

  // Amounts
  { name: "amount",          example: "242.27",              description: "Order fiat amount (₹), before TDS" },
  { name: "cryptoAmount",    example: "2.85",                description: "Crypto quantity for the order" },
  { name: "asset",           example: "USDT",                description: "Crypto asset (USDT / BTC / …)" },
  { name: "fiat",            example: "INR",                 description: "Fiat currency" },

  // PAN
  { name: "pan",             example: "ABCDE1234F",          description: "Verified PAN number" },
  { name: "panName",         example: "RAHUL SHARMA",        description: "Name as registered on the PAN" },

  // TDS amounts
  { name: "preTDS",          example: "242.27",              description: "Amount before TDS (₹)" },
  { name: "tds",             example: "2.42",                description: "TDS amount deducted, 1% (₹)" },
  { name: "postTDS",         example: "239.85",              description: "Amount seller receives after TDS (₹)" },

  // Payment
  { name: "method",          example: "IMPS",                description: "Payment method / mode (IMPS / NEFT / RTGS / Bank Transfer)" },
  { name: "upi",             example: "rahul@okhdfc",        description: "Seller's UPI ID (if provided)" },
  { name: "accountNo",       example: "50100xxxxxx123",      description: "Seller's bank account number" },
  { name: "ifsc",            example: "HDFC0001234",         description: "Seller's bank IFSC code" },
  { name: "bankName",        example: "HDFC Bank",           description: "Seller's bank name" },
  { name: "accountName",     example: "RAHUL SHARMA",        description: "Seller's bank account holder name" },
  { name: "utr",             example: "614518906536",        description: "Payment UTR / bank reference number" },
  { name: "tan",             example: "DELA12345B",          description: "Company TAN (for TDS deposit)" },

  // TDS timing (computed)
  { name: "quarter",         example: "Apr–Jun",             description: "Current TDS quarter" },
  { name: "creditMonth",     example: "Jul",                 description: "Month the TDS credit appears" },
  { name: "visibleMonth",    example: "Aug",                 description: "Month TDS becomes visible on Form 26AS" },
  { name: "year",            example: "2026",                description: "Current year" },

  // Situational (only meaningful in specific templates, blank elsewhere)
  { name: "reason",          example: "PAN inactive",        description: "Failure reason (PAN-invalid template)" },
  { name: "mismatchedSources", example: "Binance KYC, Bank Holder", description: "Which name sources didn't match (name-mismatch template)" },
  { name: "limit",           example: "100000",              description: "Max auto-pay limit (₹) (above-limit template)" },
];

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
  TEMPLATE_VARIABLES,
};
