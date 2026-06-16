// One-shot diagnostic — run on the PROD server (IP-whitelisted):
//   node scripts/paywizeDiagnose.js
//
// Calls Paywize auth, dumps the encrypted blob, then attempts decrypt with
// every plausible key combination. If decrypt succeeds, prints the JWT and
// the EXACT key configuration that worked. If all fail, tells you the key
// is wrong in .env (since the algorithm is verified-correct elsewhere).
//
// Safe to run multiple times — read-only call.

require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto");

const apiKey    = process.env.PAYWIZE_API_KEY;
const secretKey = process.env.PAYWIZE_SECRET_KEY;
const baseUrl   = process.env.PAYWIZE_BASE_URL || "https://merchant.paywize.in";

if (!apiKey || !secretKey) {
  console.error("Missing PAYWIZE_API_KEY or PAYWIZE_SECRET_KEY in env");
  process.exit(1);
}

// Reference impl (verbatim from Paywize V2 SDK reference PDF)
function decryptDataV2(encryptedData, secretKey) {
  const NONCE_LENGTH    = 12;
  const AUTH_TAG_LENGTH = 16;
  const combined = Buffer.from(encryptedData, "base64");
  if (combined.length < NONCE_LENGTH + AUTH_TAG_LENGTH) throw new Error("blob too short");
  const nonce      = combined.subarray(0, NONCE_LENGTH);
  const authTag    = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(NONCE_LENGTH, combined.length - AUTH_TAG_LENGTH);
  const key        = crypto.createHash("sha256").update(secretKey).digest();
  const decipher   = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

(async () => {
  console.log("\n=== Paywize V2 Diagnostic ===");
  console.log("baseUrl   :", baseUrl);
  console.log("apiKey    :", apiKey.slice(0, 8) + "… len=" + apiKey.length);
  console.log("secretKey :", secretKey.slice(0, 8) + "… len=" + secretKey.length);
  console.log();

  let res;
  try {
    res = await axios.post(
      `${baseUrl}/api/v1/auth/clients/token`,
      { api_key: apiKey, secret_key: secretKey },
      { headers: { "Content-Type": "application/json" }, validateStatus: () => true, timeout: 20000 }
    );
  } catch (e) {
    console.error("Network error:", e.message);
    process.exit(2);
  }

  console.log("HTTP status:", res.status);
  if (res.status !== 200) {
    console.error("Auth failed — body:", JSON.stringify(res.data));
    process.exit(3);
  }

  const data = res.data?.data;
  console.log("respCode   :", res.data.respCode);
  console.log("respMessage:", res.data.respMessage);
  console.log("expiresIn  :", res.data.expiresIn);
  console.log("tokenType  :", res.data.tokenType);
  console.log("data length:", typeof data === "string" ? data.length : typeof data);
  console.log();

  if (typeof data !== "string") {
    console.error("data is not a string — cannot decrypt");
    process.exit(4);
  }

  console.log("=== Attempting decrypt with every plausible key ===");
  const keys = [
    ["PAYWIZE_SECRET_KEY (as-is)",     secretKey],
    ["PAYWIZE_SECRET_KEY (trimmed)",   secretKey.trim()],
    ["PAYWIZE_API_KEY",                apiKey],
    ["PAYWIZE_API_KEY (trimmed)",      apiKey.trim()],
    ["apiKey + secretKey",             apiKey + secretKey],
    ["secretKey + apiKey",             secretKey + apiKey],
    ["secretKey URL-decoded",          (() => { try { return decodeURIComponent(secretKey); } catch { return null; } })()],
  ].filter(([_, k]) => k);

  let won = null;
  for (const [label, key] of keys) {
    try {
      const out = decryptDataV2(data, key);
      console.log(`✅ DECRYPT SUCCEEDED with: ${label}`);
      console.log("   plaintext:", out.slice(0, 300));
      won = label;
      break;
    } catch (e) {
      console.log(`✗  ${label.padEnd(36)} — ${e.message}`);
    }
  }

  console.log();
  if (won) {
    console.log("=== RESULT: working key is", JSON.stringify(won));
    console.log("Update paywize.js / .env accordingly.");
  } else {
    console.log("=== RESULT: NO KEY WORKS ===");
    console.log("This proves PAYWIZE_SECRET_KEY in .env does NOT match the key");
    console.log("Paywize used to encrypt the response.");
    console.log();
    console.log("ACTION REQUIRED:");
    console.log("1. Open Paywize merchant dashboard");
    console.log("2. Re-copy the secret_key fresh and paste into .env");
    console.log("3. Look for a separate 'V2 Encryption Key' field — Paywize");
    console.log("   may have given you a separate key for V2 encryption when");
    console.log("   they upgraded from V1. If yes, set THAT as PAYWIZE_SECRET_KEY.");
    console.log("4. If the dashboard only shows one secret, contact Paywize");
    console.log("   support: 'My V2 token encryption fails despite using the");
    console.log("   secret_key from the dashboard. Please check if my account");
    console.log("   has a separate V2 encryption key.'");
  }

  console.log("\nFull blob (for offline analysis):");
  console.log(data);

  // ── Wallet ID probe ────────────────────────────────────────────────────────
  // Paywize 4023 = "Missing or invalid wallet_id". The value we have in
  // .env (PAYWIZE_WALLET_ID) isn't recognised. Use the now-valid JWT to hit
  // /balance with what we have, and also enumerate plausible variants so we
  // can see exactly what Paywize considers a valid wallet identifier.
  let workingKey;
  for (const [label, key] of keys) {
    try { decryptDataV2(data, key); workingKey = key; break; } catch (_) {}
  }
  if (!workingKey) return;

  let token;
  try {
    const plain = decryptDataV2(data, workingKey).trim();
    token = plain.startsWith("eyJ") ? plain : (JSON.parse(plain).token || plain);
  } catch (e) {
    console.log("\n(skipping wallet probe — couldn't extract JWT:", e.message + ")");
    return;
  }

  const envWalletId = process.env.PAYWIZE_WALLET_ID;
  // Generate O/0 swap variants so we catch the screenshot-OCR ambiguity.
  function letterDigitSwap(s) {
    const out = new Set([s]);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "O") out.add(s.slice(0, i) + "0" + s.slice(i + 1));
      if (s[i] === "0") out.add(s.slice(0, i) + "O" + s.slice(i + 1));
      if (s[i] === "I") out.add(s.slice(0, i) + "1" + s.slice(i + 1));
      if (s[i] === "1") out.add(s.slice(0, i) + "I" + s.slice(i + 1));
      if (s[i] === "l") out.add(s.slice(0, i) + "1" + s.slice(i + 1));
    }
    return [...out];
  }

  const baseValues = [
    envWalletId,
    "PAYWIZE517725O60",
    "PAYWIZE517725060",
    "PAYWIZE51772506O",
    "PAYWIZE51772500O",
    "517725060",
    "517725O60",
    "8422436550",
  ];
  const candidates = [...new Set(baseValues.flatMap(letterDigitSwap))].filter(Boolean);

  console.log("\n=== Probing /payout/balance to find correct wallet_id ===");
  // Also try the endpoint WITHOUT wallet_id to see if Paywize returns the
  // list of wallets associated with this account.
  for (const path of ["/payout/v1/balance", "/api/v1/payout/balance", "/api/v1/payout/check-balance"]) {
    try {
      const r = await axios.get(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true, timeout: 15000,
      });
      const body = typeof r.data === "object" ? JSON.stringify(r.data) : String(r.data);
      console.log(`[${r.status}] GET ${path.padEnd(35)} (no params)   → ${body.slice(0, 250)}`);
    } catch (e) { console.log(`err  GET ${path} — ${e.message}`); }

    for (const wid of candidates) {
      try {
        const r = await axios.get(`${baseUrl}${path}`, {
          params:  { wallet_id: wid },
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true, timeout: 15000,
        });
        const body = typeof r.data === "object" ? JSON.stringify(r.data) : String(r.data);
        const tag  = r.status === 200 ? "✅" : (r.status === 404 ? "·" : "⚠");
        console.log(`${tag} [${r.status}] GET ${path.padEnd(35)} wid=${String(wid).padEnd(20)} → ${body.slice(0, 200)}`);
      } catch (e) { console.log(`err  GET ${path} wid=${wid} — ${e.message}`); }
    }
  }
})();
