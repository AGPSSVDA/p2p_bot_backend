const crypto = require('crypto');
const axios  = require('axios');
const { config } = require('../config/config');
const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Clock-sync with Binance — fixes -1021 "timestamp ahead of server" errors
//  caused by local clock drift. Refresh every few minutes.
//
//  Safety margin: we send timestamp ~500ms BEHIND server time. Binance
//  rejects if timestamp > serverTime + 1000ms, but allows up to recvWindow
//  ms behind, so being 500ms behind is comfortably within tolerance.
// ─────────────────────────────────────────────────────────────────────────────
const TIMESTAMP_SAFETY_MS = 500;
let _timeOffsetMs = 0;

async function syncBinanceTime() {
  try {
    const t0  = Date.now();
    const res = await axios.get(
      `${config.binance.baseUrl}/api/v3/time`,
      { timeout: 8000 }
    );
    const t1  = Date.now();
    const rtt = t1 - t0;
    // Binance reply approximates serverTime at ~midpoint of round-trip
    _timeOffsetMs = res.data.serverTime - Math.round((t0 + t1) / 2);
    logger.info('Binance clock synced', { offsetMs: _timeOffsetMs, rttMs: rtt });
    return _timeOffsetMs;
  } catch (err) {
    logger.warn('Binance clock sync failed (using existing offset)', {
      error: err.message, offsetMs: _timeOffsetMs,
    });
    return _timeOffsetMs;
  }
}

function nowMs() {
  return Date.now() + _timeOffsetMs - TIMESTAMP_SAFETY_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SAPI v7.4 Signature
//  Insertion order preserved — Binance signs the EXACT query string sent.
// ─────────────────────────────────────────────────────────────────────────────
function signQuery(queryString) {
  return crypto
    .createHmac('sha256', config.binance.secretKey)
    .update(queryString)
    .digest('hex');
}

function buildSignedQuery(params = {}) {
  const timestamp = nowMs();
  const allParams = { ...params, timestamp };
  const queryStr  = Object.entries(allParams)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = signQuery(queryStr);
  return `${queryStr}&signature=${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAN Helpers
// ─────────────────────────────────────────────────────────────────────────────
function extractPAN(text) {
  if (!text) return null;
  const cleaned = String(text).toUpperCase().replace(/\s+/g, '');
  const match   = cleaned.match(/[A-Z]{5}[0-9]{4}[A-Z]{1}/);
  return match ? match[0] : null;
}

function isValidPANFormat(pan) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test((pan || '').toUpperCase());
}

function maskPAN(pan) {
  if (!pan || pan.length !== 10) return 'INVALID';
  return pan.slice(0, 3) + 'XX' + pan.slice(5, 9) + 'X';
}

// ─────────────────────────────────────────────────────────────────────────────
//  TDS Calculation
// ─────────────────────────────────────────────────────────────────────────────
function calculateTDS(amount, tdsPercent) {
  const tdsAmount  = (amount * tdsPercent) / 100;
  const postAmount = amount - tdsAmount;
  return {
    preTDS:  amount,
    tds:     parseFloat(tdsAmount.toFixed(2)),
    postTDS: parseFloat(postAmount.toFixed(2)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Problem keyword detector — word-boundary match
//  Avoids false positives like "ha" matching "have", "thanks", etc.
// ─────────────────────────────────────────────────────────────────────────────
const PROBLEM_KEYWORDS = [
  'cancel', 'fraud', 'scam', 'cheat', 'cheated',
  'police', 'complaint', 'report fraud',
  'galat', 'dhoka', 'mat karo', 'paisa wapas',
];

function isProblemMessage(text) {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return false;
  return PROBLEM_KEYWORDS.some(kw => {
    if (kw.includes(' ')) return lower.includes(kw);
    return new RegExp(`\\b${kw}\\b`, 'i').test(lower);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Agreement detector for TDS consent
// ─────────────────────────────────────────────────────────────────────────────
// Strict TDS-consent matcher. Per business rule, the bot ONLY proceeds when
// the seller types the exact phrase "I AGREE" (any case). Previous looser
// matching ("yes", "ok", standalone "agree") was a false-positive risk —
// messages like "not agree", "don't agree", "no" or just "yes" would all
// sneak through the old standalone-"agree" / "yes" branches.
//
// Rules:
//   1. Normalise the text (lowercase, strip emojis/punctuation, collapse
//      whitespace).
//   2. Reject outright if any negation token appears anywhere in the text.
//   3. Accept only if the normalised text contains the exact phrase
//      "i agree" (with optional trailing 'd' / 's'). The whole-word
//      boundary check rules out things like "disagree".
function isAgreementMessage(text) {
  if (!text) return false;

  const norm = String(text)
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')   // strip emojis / punctuation
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return false;

  // Hard reject — any negation token kills the match
  if (/\b(not|no|nope|nah|don'?t|do\s+not|cannot|can'?t|never|disagree|reject|deny|wrong|refuse)\b/.test(norm)) {
    return false;
  }

  // Must contain the exact phrase "i agree" (case-insensitive, whitespace-
  // tolerant, accepts "i agreed" / "i agrees" variants too)
  return /\bi\s+agree(d|s)?\b/.test(norm);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Name matching — Indian names: handle titles, ordering, middle-name variance
//
//  Returns: { matched: bool, kind: 'exact'|'subset'|'fuzzy', score, reason }
// ─────────────────────────────────────────────────────────────────────────────
function _normalizeName(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^\w\s]/g, ' ')                                  // strip punctuation
    .replace(/\b(MR|MRS|MS|MISS|SHRI|SMT|DR|SH|SRI)\b\.?/g, '')// strip honorifics
    .replace(/\s+/g, ' ')
    .trim();
}

function matchNames(a, b, mode = 'subset') {
  if (mode === 'off') return { matched: true, kind: 'skip' };

  const A = _normalizeName(a);
  const B = _normalizeName(b);
  if (!A || !B) return { matched: false, kind: 'empty', reason: 'one side empty' };

  if (A === B) return { matched: true, kind: 'exact' };
  if (mode === 'exact') return { matched: false, kind: 'no_exact', reason: `"${A}" != "${B}"` };

  // Keep tokens of length >= 1 so initials ("A R RAHMAN") aren't dropped
  const tokensA = A.split(' ').filter(Boolean);
  const tokensB = B.split(' ').filter(Boolean);
  if (!tokensA.length || !tokensB.length) {
    return { matched: false, kind: 'empty', reason: 'no usable tokens' };
  }

  // STRICT subset: every token of the SHORTER name must appear in the longer.
  // No fuzzy fallback — first-name-only matches are too risky in P2P context
  // (two real people can share a first name; family name identity-critical).
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const setLonger = new Set(longer);
  if (shorter.every(t => setLonger.has(t))) {
    return { matched: true, kind: 'subset', score: shorter.length / longer.length };
  }

  const shared = shorter.filter(t => setLonger.has(t)).length;
  const overlap = shared / Math.max(shorter.length, longer.length);
  return {
    matched: false,
    kind:    'no_match',
    reason:  `"${A}" vs "${B}" — only ${Math.round(overlap * 100)}% tokens overlap`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Token-intersection name match
//
//  Looser than matchNames(): passes if ANY name token (first / middle / last)
//  in `a` matches ANY token in `b`. Honorifics + punctuation stripped; short
//  initials kept. Used by the dual-source check (PAN ↔ KYC, then PAN ↔ bank
//  holder) where we want to be tolerant of middle-name reordering / drops.
// ─────────────────────────────────────────────────────────────────────────────
function _tokenize(name) {
  return _normalizeName(name)
    .split(' ')
    .filter(Boolean);
}

function tokenIntersectionMatch(a, b) {
  const tokensA = _tokenize(a);
  const tokensB = _tokenize(b);
  if (!tokensA.length || !tokensB.length) {
    return {
      matched: false,
      reason:  'one side empty',
      overlap: [],
      tokensA, tokensB,
    };
  }
  const setA = new Set(tokensA);
  const overlap = [...new Set(tokensB.filter(t => setA.has(t)))];
  return {
    matched: overlap.length > 0,
    overlap,
    tokensA,
    tokensB,
    reason: overlap.length
      ? `matched on [${overlap.join(', ')}]`
      : `no shared tokens between [${tokensA.join(' ')}] and [${tokensB.join(' ')}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Retry wrapper
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delayMs = 3000, label = '') {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const meta = { error: err.message };
      let bizCode;
      if (err.response) {
        meta.status = err.response.status;
        const body = err.response.data;
        meta.body = typeof body === 'string'
          ? body.substring(0, 400)
          : JSON.stringify(body).substring(0, 400);
        bizCode = (typeof body === 'object' && body) ? body.code : null;
      }
      logger.warn(`${label} attempt ${i}/${retries} failed`, meta);

      // NEVER retry a wrong fund/security password — Binance locks the account
      // after 3 wrong attempts. 83893 = "last chance", 83895/83896 = fund password
      // incorrect. Abort immediately so one release attempt only ever consumes ONE
      // password try (a retry here could burn the last chance and lock the account).
      if (bizCode === 83893 || bizCode === 83895 || bizCode === 83896) {
        logger.error(`${label}: wrong/last-chance fund password (code ${bizCode}) — aborting (NOT retrying) to preserve remaining attempts`);
        throw err;
      }

      // -1021: Timestamp drifted out of tolerance — re-sync immediately
      // and shrink the wait so the next retry uses the fresh offset.
      if (bizCode === -1021 && i < retries) {
        logger.info('Re-syncing clock after -1021');
        await syncBinanceTime().catch(() => {});
        await sleep(500);
        continue;
      }

      if (i < retries) await sleep(delayMs);
    }
  }
  const detail = lastErr?.response?.data
    ? ` body=${JSON.stringify(lastErr.response.data).substring(0, 200)}`
    : '';
  throw new Error(`${label} failed after ${retries} retries: ${lastErr?.message || ''}${detail}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older Node
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parse bank account number + IFSC from a seller's free-form chat message
//
//  Accepts a wide variety of phrasings the seller might type:
//    "Account Number - 1234567890\nifsc - ABCD0001234"
//    "ACC NO: 1234567890   IFSC: ABCD0001234"
//    "a/c 1234567890 abcd0001234"
//    "Bank A/c 1234567890 ifsc - ABCD0001234"
//
//  Returns { accountNo, ifsc } — either field may be null if not found.
//  IFSC is normalised to uppercase. Account number is digits only, 4–25 chars.
// ─────────────────────────────────────────────────────────────────────────────
const IFSC_RE = /\b([A-Za-z]{4}0[A-Za-z0-9]{6})\b/;

function parseBankAccountInput(text) {
  if (!text) return { accountNo: null, ifsc: null };

  const flat = String(text).replace(/\s+/g, ' ').trim();

  // IFSC first (strict — 4 letters + 0 + 6 alphanumeric)
  let ifsc = null;
  const ifscMatch = flat.match(IFSC_RE);
  if (ifscMatch) ifsc = ifscMatch[1].toUpperCase();

  // Strip the IFSC from the text so its digits don't get parsed as an
  // account number on the next pass.
  const withoutIfsc = ifsc
    ? flat.replace(new RegExp(ifsc, "ig"), "")
    : flat;

  // Account number — try labeled patterns first, then any standalone digit run.
  let accountNo = null;
  const labeledPatterns = [
    /\ba\/?c(?:count)?\s*(?:no|num|number)?\s*[:\-=]?\s*(\d{4,25})/i,
    /\baccount\s*(?:no|num|number)?\s*[:\-=]?\s*(\d{4,25})/i,
    /\bacc\b\s*[:\-=]?\s*(\d{4,25})/i,
    /\bbank\s*(?:a\/?c|account)?\s*(?:no|num|number)?\s*[:\-=]?\s*(\d{4,25})/i,
  ];
  for (const re of labeledPatterns) {
    const m = withoutIfsc.match(re);
    if (m) { accountNo = m[1]; break; }
  }
  if (!accountNo) {
    // Fallback: any 4–25-digit run that isn't an IFSC's number portion.
    const m = withoutIfsc.match(/\b(\d{4,25})\b/);
    if (m) accountNo = m[1];
  }

  return { accountNo, ifsc };
}

module.exports = {
  signQuery, buildSignedQuery,
  syncBinanceTime, nowMs,
  extractPAN, isValidPANFormat, maskPAN,
  calculateTDS,
  isProblemMessage, isAgreementMessage,
  matchNames, tokenIntersectionMatch,
  parseBankAccountInput,
  withRetry, sleep, formatINR, uuidv4,
};
