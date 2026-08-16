const { pool } = require('../../config/mysql');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  sellerMessageService — DB-driven chat templates for the SELLER bot.
//
//  Mirrors the buyer-side messageService but scoped to category = 'seller'.
//  Every outbound seller-bot message resolves to a template_key; the admin edits
//  these on the seller "Chat Messages" page. A key may have 1–5 variations; we
//  pick one at random per send (more natural in chat), then fill {var} tokens.
//
//  Cached in-memory for 30s so we don't hit MySQL on every send; an edit takes
//  effect within ~30s (or immediately after invalidate()).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cache = null; // { key: [text, text, ...] }
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
        WHERE g.category = 'seller'
        ORDER BY g.template_key ASC, m.step_order ASC
      `);
      const next = {};
      for (const r of rows) {
        if (!r.template_key) continue;
        if (!next[r.template_key]) next[r.template_key] = [];
        if (r.message_text) next[r.template_key].push(r.message_text);
      }
      cache = next;
      cacheLoadedAt = Date.now();
    } catch (err) {
      logger.error('Failed to load seller message templates from DB', { error: err.message });
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
  if (!template) return '';
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), v == null ? '' : String(v)),
    template
  );
}

/**
 * Resolve a seller template to a ready-to-send string.
 * Picks a random variation, fills {var} tokens. Falls back to `fallback` (the
 * old hardcoded text) if the key/message is missing, so the bot never sends "".
 */
async function get(key, vars = {}, fallback = '') {
  await ensureCache();
  const texts = cache?.[key];
  if (!texts || texts.length === 0) {
    if (!fallback) logger.warn('Seller template missing in DB', { key });
    return fill(fallback, vars);
  }
  const pick = texts[Math.floor(Math.random() * texts.length)];
  return fill(pick, vars);
}

function invalidate() {
  cache = null;
  cacheLoadedAt = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELLER TEMPLATE VARIABLES (for the frontend variable palette)
//  These are the {tokens} the bot fills at send time.
// ─────────────────────────────────────────────────────────────────────────────
const TEMPLATE_VARIABLES = [
  { name: 'otp',         example: '123456',       description: 'The OTP code (SMS OTP template — must keep {otp} where the code goes)' },
  { name: 'hours',       example: '12',           description: 'Re-order cooldown: hours LEFT before the buyer can order again' },
  { name: 'cooldownHours', example: '24',         description: 'Re-order cooldown: the configured cooldown window (hours)' },
  { name: 'docType',     example: 'Aadhaar',      description: 'Document being verified (Aadhaar / PAN)' },
  { name: 'kycName',     example: 'RAHUL SHARMA',  description: "Buyer's Binance KYC name" },
  { name: 'docName',     example: 'RAHUL SHARMA',  description: 'Name extracted from the uploaded document' },
  { name: 'attempt',     example: '2',            description: 'Current attempt number for this document' },
  { name: 'maxAttempts', example: '3',            description: 'Maximum attempts allowed per document' },
  { name: 'reason',      example: 'PAN inactive', description: 'PAN verification failure reason (Surepass)' },
  { name: 'missing',     example: 'Aadhaar back, PAN card', description: 'List of documents still pending' },
  { name: 'mobile',      example: '7210',         description: 'Last 4 digits of the buyer\'s mobile (OTP-sent message)' },
  { name: 'amount',      example: '210',          description: 'Method 3: order fiat amount to pay' },
  { name: 'fiat',        example: 'INR',          description: 'Method 3: fiat currency' },
  { name: 'link',        example: 'https://…',    description: 'Method 3: payment link/QR URL' },
  { name: 'qr',          example: 'https://…/qr/pay_123.png', description: 'Method 3: scannable QR image URL of the payment link' },
  { name: 'payerName',   example: 'RAHUL SHARMA', description: 'Method 3: payer bank/card name (mismatch message)' },
  { name: 'orderNo',     example: '22899…416',    description: 'Binance order number' },
];

module.exports = { get, invalidate, fill, TEMPLATE_VARIABLES };
