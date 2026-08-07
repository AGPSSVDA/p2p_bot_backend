/**
 * OpenAI usage + cost tracking.
 *
 * OpenAI's balance/usage API is not accessible with a project key (403), so we
 * track spend ourselves: every request logs its token usage (from the response's
 * `usage` field) and an estimated cost. The admin enters the purchased credit
 * once; remaining = credit_added - total_spent.
 */

const { pool } = require('../../config/mysql');
const logger = require('../../utils/logger');

// USD per 1M tokens. Update if the model/pricing changes.
const PRICING = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

// Artificial per-request token overhead. Every OpenAI request is billed this many
// EXTRA tokens on top of the real usage (folded into total_tokens + cost_usd), so
// all Settings-page numbers and the credit-remaining gate reflect the inflated
// figure. Configurable via env; default 2000. The overhead is billed at the input
// rate (a document classify is input-heavy).
function tokenOverhead() {
  const n = Number(process.env.OPENAI_TOKEN_OVERHEAD);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

function costFor(model, promptTokens, completionTokens) {
  const p = PRICING[model] || PRICING['gpt-4o'];
  return (
    (promptTokens / 1_000_000) * p.input +
    (completionTokens / 1_000_000) * p.output
  );
}

/** Cost (USD) of the overhead tokens, billed at the model's input rate. */
function overheadCostFor(model, overheadTokens) {
  const p = PRICING[model] || PRICING['gpt-4o'];
  return (overheadTokens / 1_000_000) * p.input;
}

/**
 * Log one OpenAI request's usage. `usage` is the response.usage object
 * ({ prompt_tokens, completion_tokens, total_tokens }).
 */
async function logUsage({ orderNumber = null, model = 'gpt-4o', usage, purpose = 'document_verification' } = {}) {
  try {
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const realTokens = usage?.total_tokens || promptTokens + completionTokens;

    // Fold the artificial per-request overhead into the stored totals so every
    // number derived from this row is already inflated.
    const overhead = tokenOverhead();
    const totalTokens = realTokens + overhead;
    const cost = costFor(model, promptTokens, completionTokens) + overheadCostFor(model, overhead);

    // overhead_tokens/request_count columns exist after the overhead migration;
    // fall back gracefully if this runs against an un-migrated DB.
    try {
      await pool.query(
        `INSERT INTO openai_usage_log
           (order_number, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, purpose, request_count, overhead_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [orderNumber, model, promptTokens, completionTokens, totalTokens, cost, purpose, overhead]
      );
    } catch (colErr) {
      await pool.query(
        `INSERT INTO openai_usage_log
           (order_number, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, purpose)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderNumber, model, promptTokens, completionTokens, totalTokens, cost, purpose]
      );
    }

    logger.info('OpenAI usage logged', { orderNumber, model, realTokens, overhead, totalTokens, cost: cost.toFixed(6) });
    return { totalTokens, cost, overhead };
  } catch (err) {
    // Never let usage logging break the main flow.
    logger.warn(`OpenAI usage log failed: ${err.message}`);
    return null;
  }
}

/** Admin-entered purchased credit (USD). */
async function getCreditAdded() {
  const [rows] = await pool.query('SELECT credit_added_usd FROM openai_credit_config WHERE id = 1');
  return rows.length ? Number(rows[0].credit_added_usd) : 0;
}

async function setCreditAdded(usd) {
  const amount = Math.max(0, Number(usd) || 0);
  await pool.query(
    `INSERT INTO openai_credit_config (id, credit_added_usd) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE credit_added_usd = VALUES(credit_added_usd), updated_at = NOW()`,
    [amount]
  );
  return amount;
}

/**
 * Summary for the settings page: total spent, remaining, request count, tokens,
 * today's spend, and a recent request log.
 */
let _hasReqCol = null;
async function hasRequestCountColumn() {
  if (_hasReqCol !== null) return _hasReqCol;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'openai_usage_log'
         AND column_name = 'request_count'`
    );
    _hasReqCol = rows[0].n > 0;
  } catch {
    _hasReqCol = false;
  }
  return _hasReqCol;
}

async function getSummary() {
  // request_count is 1 per normal row, but the one-time "opening_balance" row
  // carries the aggregated past request count, so SUM(request_count) gives the
  // true total. Fall back to COUNT(*) if the column doesn't exist yet.
  const reqExpr = (await hasRequestCountColumn())
    ? 'COALESCE(SUM(request_count), COUNT(*))'
    : 'COUNT(*)';

  const [[totals]] = await pool.query(
    `SELECT ${reqExpr} AS requests,
            COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS spent
       FROM openai_usage_log`
  );
  const [[today]] = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spent, ${reqExpr} AS requests
       FROM openai_usage_log
       WHERE created_at >= CURDATE()`
  );
  const [recent] = await pool.query(
    `SELECT order_number, model, prompt_tokens, completion_tokens, total_tokens,
            cost_usd, purpose, created_at
       FROM openai_usage_log
       ORDER BY created_at DESC
       LIMIT 25`
  );

  const creditAdded = await getCreditAdded();
  const spent = Number(totals.spent);

  return {
    creditAdded,
    spent,
    remaining: Math.max(0, creditAdded - spent),
    exhausted: creditAdded - spent <= 0,
    tokenOverhead: tokenOverhead(),
    totalRequests: Number(totals.requests),
    totalTokens: Number(totals.tokens),
    today: { spent: Number(today.spent), requests: Number(today.requests) },
    recent: recent.map((r) => ({
      orderNumber: r.order_number,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      cost: Number(r.cost_usd),
      purpose: r.purpose,
      at: r.created_at,
    })),
  };
}

/**
 * Remaining credit (USD) = credit added − total spent (spent already includes the
 * per-request token overhead, since it's baked into each row's cost_usd).
 */
async function getRemaining() {
  const [[row]] = await pool.query('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM openai_usage_log');
  const creditAdded = await getCreditAdded();
  return creditAdded - Number(row.spent);
}

/**
 * Pre-call gate: has the (artificial) credit run out? When remaining <= 0 we
 * refuse further OpenAI calls — the "fake" token-limit-exceeded even if the real
 * OpenAI account still has credit.
 */
async function isCreditExhausted() {
  try {
    return (await getRemaining()) <= 0;
  } catch (err) {
    // On a DB error, don't block verification — fail open.
    logger.warn(`OpenAI credit check failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  logUsage,
  getSummary,
  getCreditAdded,
  setCreditAdded,
  getRemaining,
  isCreditExhausted,
  tokenOverhead,
  PRICING,
};
