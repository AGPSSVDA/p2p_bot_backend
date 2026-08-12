/**
 * Get seller ID from environment or fallback to user ID
 * SELLER_ID in .env is the Binance P2P merchant ID
 * This should be used for all seller-related queries
 */
function getSellerIdFromRequest(req) {
  // Priority: .env SELLER_ID > req.user.id
  const sellerId = process.env.SELLER_ID || (req?.user?.id);
  return sellerId;
}

/** Normalise a name for comparison: uppercase, strip punctuation/honorifics. */
function _norm(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(MR|MRS|MS|MISS|SHRI|SMT|DR|SH|SRI|S\/O|D\/O|W\/O)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two name tokens "match" if equal OR one is a prefix of the other (>=3 chars). */
function _tokenMatch(x, y) {
  if (!x || !y) return false;
  if (x === y) return true;
  // Handles "FIROJ" ⊂ "FIROJABHAI" (Aadhaar often appends "BHAI/BEN/KUMAR" etc.)
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return shorter.length >= 3 && longer.startsWith(shorter);
}

/**
 * LOOSE name match for the SELLER side (Aadhaar / PAN / payer vs Binance KYC).
 *
 * Rule (per requirement): case-insensitive, and it's a MATCH if ANY token of one
 * name matches ANY token of the other — i.e. the first OR the last name matches
 * (with prefix tolerance so "Firoj" ≈ "Firojabhai"). Looser than the buyer-side
 * helpers.matchNames() on purpose; does NOT modify buyer code.
 *
 * @returns {{matched:boolean, kind:string, reason?:string}}
 */
function matchNamesLoose(a, b) {
  const A = _norm(a);
  const B = _norm(b);
  if (!A || !B) return { matched: false, kind: 'empty', reason: 'one side empty' };
  if (A === B) return { matched: true, kind: 'exact' };

  const ta = A.split(' ').filter(Boolean);
  const tb = B.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return { matched: false, kind: 'empty', reason: 'no tokens' };

  // Match if any token pair matches (first-name OR last-name, prefix-tolerant).
  for (const x of ta) {
    for (const y of tb) {
      if (_tokenMatch(x, y)) {
        return { matched: true, kind: 'token', reason: `"${x}" ≈ "${y}"` };
      }
    }
  }
  return { matched: false, kind: 'no_match', reason: `"${A}" vs "${B}" — no common name` };
}

module.exports = {
  getSellerIdFromRequest,
  matchNamesLoose,
};
