const crypto = require("crypto");
const { config } = require("../../config/config");
const logger = require("../../utils/logger");
const orderDbService = require("../orderDbService");
const {
  call,
  deterministicTransferId,
  chooseTransferMode,
  runCommonPreflightGates,
} = require("./common");

// ─────────────────────────────────────────────────────────────────────────────
//  Paywize Payouts provider — V2 (AES-256-GCM) Encryption
//
//  Base URL: https://merchant.paywize.in (override via PAYWIZE_BASE_URL).
//
//  Endpoints (live API — verified against merchant.paywize.in):
//      POST /api/v1/auth/clients/token   — JWT (5 min TTL) — encrypted payload
//      POST /api/v1/payout/initiate      — initiate a payout — encrypted payload
//      GET  /api/v1/payout/status        — status by sender_id OR transaction_id
//      GET  /api/v1/payout/balance       — wallet balance check
//
//  IP allowlist: Paywize gates all /api/v1/* endpoints on server IP — your
//  deploy host's outbound IP must be added in the Paywize dashboard before
//  any call will succeed (otherwise you get 403 "Your IP address is not allowed").
//
//  Encryption (V2):
//      key   = SHA-256(secretKey)                  (32 B)
//      nonce = crypto.randomBytes(12)
//      out   = base64( nonce || ciphertext || authTag(16) )
//
//  Webhook (per /api-docs/payout/webhook):
//      Header   : X-Paywize-Signature: sha256=<hex>
//      Hashing  : HMAC-SHA256(rawBody, secretKey), hex-encoded
//      Trigger  : per-request `callback_url` we send in /payout/v1/initiate.
//                 There is NO dashboard webhook URL to register — Paywize
//                 calls back whatever URL we pass per payout.
//      Payload  : { data: "<encrypted base64>" } → decrypt to:
//                 { transaction_id, sender_id, wallet_id, amount,
//                   payment_mode, status, utr_number, status_message,
//                   beneficiary, timestamps }
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER = "paywize";

// ─── AES helpers — try V2 (GCM) first, fall back to V1 (CBC) ────────────────
//   Live Paywize accounts can be on either scheme: V2 GCM (newer, AEAD) or
//   V1 CBC (legacy, used by their auth response). decrypt() probes both so a
//   single integration handles either tier.
function encrypt(data, secretKey) {
  if (typeof data === "object") data = JSON.stringify(data);
  const nonce  = crypto.randomBytes(12);
  const key    = crypto.createHash("sha256").update(secretKey).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(data, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, authTag]).toString("base64");
}

// V2 — AES-256-GCM. Wire format: base64( nonce(12) || ciphertext || tag(16) ).
function decryptGcm(encryptedData, secretKey) {
  const combined     = Buffer.from(encryptedData, "base64");
  const NONCE_LEN    = 12;
  const AUTH_TAG_LEN = 16;
  const nonce      = combined.subarray(0, NONCE_LEN);
  const authTag    = combined.subarray(combined.length - AUTH_TAG_LEN);
  const ciphertext = combined.subarray(NONCE_LEN, combined.length - AUTH_TAG_LEN);
  const key        = crypto.createHash("sha256").update(secretKey).digest();
  const decipher   = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  let plain = decipher.update(ciphertext, undefined, "utf8");
  plain += decipher.final("utf8");
  return plain;
}

// V1 — AES-256-CBC. Wire format: base64( iv(16) || ciphertext ). Key is
// SHA-256 of secretKey (same as GCM) — the difference is mode + IV layout
// and no auth tag. Some Paywize tenants still respond with this on /auth.
function decryptCbc(encryptedData, secretKey) {
  const combined = Buffer.from(encryptedData, "base64");
  const IV_LEN   = 16;
  const iv         = combined.subarray(0, IV_LEN);
  const ciphertext = combined.subarray(IV_LEN);
  const key        = crypto.createHash("sha256").update(secretKey).digest();
  const decipher   = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let plain = decipher.update(ciphertext, undefined, "utf8");
  plain += decipher.final("utf8");
  return plain;
}

// Public decrypt — keeps name stable for callers; tries V2 then V1.
function decrypt(encryptedData, secretKey) {
  try { return decryptGcm(encryptedData, secretKey); } catch (_) {}
  return decryptCbc(encryptedData, secretKey);
}

// Convenience: decrypt a possibly-encrypted JSON `data` field. Accepts already-
// decoded objects too (some responses return data unencrypted on auth/balance).
function tryDecryptToObject(maybeEncrypted, secretKey) {
  if (!maybeEncrypted) return null;
  if (typeof maybeEncrypted === "object") return maybeEncrypted;
  // Probe GCM first (V2 — newer accounts), then CBC (V1 — auth response).
  for (const fn of [decryptGcm, decryptCbc]) {
    try {
      const plain = fn(maybeEncrypted, secretKey);
      try { return JSON.parse(plain); } catch (_) { return plain; }
    } catch (_) { /* try next mode */ }
  }
  logger.warn("Paywize decrypt failed — neither GCM nor CBC succeeded", {
    sample: String(maybeEncrypted).slice(0, 40) + "…",
  });
  return null;
}

// ─── JWT extraction — Paywize V2 auth response ──────────────────────────────
//   Confirmed against live API + reference SDK:
//     1. { token: "<JWT>" }                          (plaintext shape)
//     2. { data: "<JWT>" }                           (raw JWT in data)
//     3. { data: { token: "<JWT>" } }                (nested)
//     4. { data: "<encrypted base64 — AES-256-GCM>" }
//        → decrypt with SHA-256(secretKey)
//        → plaintext is a RAW JWT string (Keycloak-issued RS256, not JSON)
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function isJwt(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return JWT_RE.test(t) && t.length > 40;
}

function extractPaywizeToken(body) {
  if (!body) return null;

  // Shape 1 — JWT at root of response under various names.
  for (const k of ["token", "access_token", "accessToken", "jwt"]) {
    if (isJwt(body[k])) return String(body[k]).trim();
  }

  const dataField = body.data;
  if (!dataField) return null;

  // Shape 3 — { data: { token } }
  if (typeof dataField === "object") {
    for (const k of ["token", "access_token", "accessToken", "jwt"]) {
      if (isJwt(dataField[k])) return String(dataField[k]).trim();
    }
    return null;
  }

  if (typeof dataField !== "string") return null;

  // Shape 2 — data is already a JWT string (plaintext mode, rare).
  if (isJwt(dataField)) return dataField.trim();

  // Shape 4 — encrypted blob. AES-256-GCM with SHA-256(secretKey) is the
  // Paywize V2 spec; CBC + apiKey are fallbacks for legacy tenants we
  // haven't seen in prod but the SDK reference doesn't preclude.
  const candidates = [
    config.paywize.secretKey,
    config.paywize.apiKey,
  ].filter(Boolean);

  for (const seed of candidates) {
    for (const decryptFn of [decryptGcm, decryptCbc]) {
      try {
        const plain = decryptFn(dataField, seed);
        const trimmed = plain.trim();

        // Case 4a: plaintext is a raw JWT string (confirmed via live diag).
        if (isJwt(trimmed)) return trimmed;

        // Case 4b: plaintext is a JSON object wrapping the JWT.
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            for (const k of ["token", "access_token", "accessToken", "jwt"]) {
              if (isJwt(parsed[k])) return String(parsed[k]).trim();
            }
          } else if (isJwt(parsed)) {
            return String(parsed).trim();
          }
        } catch (_) { /* not JSON — already handled above */ }
      } catch (_) { /* try next key/mode */ }
    }
  }

  return null;
}

// ─── Auth token cache (5-min TTL per docs, refresh 30s early) ────────────────
let tokenCache = { value: null, expiresAtMs: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAtMs - 30_000) {
    return tokenCache.value;
  }
  // Auth endpoint is PLAIN JSON (not encrypted) with snake_case field names —
  // confirmed against live API which rejects encrypted `payload` with:
  //   "property payload should not exist"
  //   "api_key should not be empty"
  //   "secret_key should not be empty"
  const res = await call({
    method:  "POST",
    url:     `${config.paywize.baseUrl}/api/v1/auth/clients/token`,
    headers: { "Content-Type": "application/json" },
    data:    {
      api_key:    config.paywize.apiKey,
      secret_key: config.paywize.secretKey,
    },
  });
  if (!res.ok) {
    // Surface the full server reply — Paywize 400s carry the actual reason
    // (missing field, bad encryption, IP issue) in body.message or .errors,
    // and the generic "unknown" fallback hides exactly that signal.
    const bodyDump = res.body
      ? (typeof res.body === "object" ? JSON.stringify(res.body) : String(res.body))
      : (res.error || "no body");
    const reason = res.body?.respMessage
                || res.body?.resp_message
                || res.body?.message
                || res.body?.error
                || res.error
                || "unknown";
    logger.error("Paywize token fetch — non-2xx response", {
      status:   res.status,
      body:     bodyDump.slice(0, 500),
      baseUrl:  config.paywize.baseUrl,
    });
    throw new Error(`Paywize token fetch failed [${res.status}]: ${reason} | body=${bodyDump.slice(0, 200)}`);
  }

  // Extract the JWT. Live Paywize responses vary by account tier — handle
  // every shape we've seen plus exhaustive decrypt fallbacks.
  const b = res.body || {};
  const token = extractPaywizeToken(b);

  if (!token) {
    // Dump everything diagnostic so we can identify the exact response shape.
    const dataField  = b.data;
    const dataDump   = typeof dataField === "string"
      ? `string(len=${dataField.length}): ${dataField.slice(0, 120)}…`
      : `${typeof dataField}: ${JSON.stringify(dataField).slice(0, 200)}`;
    logger.error("Paywize token fetch — could not extract JWT", {
      bodyKeys:   Object.keys(b).join(","),
      respCode:   b.respCode ?? b.resp_code,
      respMsg:    b.respMessage ?? b.resp_message,
      tokenType:  b.tokenType,
      expiresIn:  b.expiresIn ?? b.expires_in,
      data:       dataDump,
      // Full body in one place for the operator to inspect
      fullBody:   JSON.stringify(b).slice(0, 800),
    });
    throw new Error(`Paywize token fetch — could not extract JWT (keys=${Object.keys(b).join(",")})`);
  }

  const ttlSec = Number(b.expiresIn || b.expires_in) || 300;
  tokenCache = {
    value:       token,
    expiresAtMs: Date.now() + (ttlSec * 1000),
  };
  logger.info("Paywize token acquired", { ttlSec, jwtPreview: String(token).slice(0, 24) + "…" });
  return token;
}

// ─── Endpoint resolver — self-discovers the live path layout ────────────────
//   Paywize public docs and the live API don't agree on path prefixes — auth
//   lives at /api/v1/auth/* but payout lives at /payout/v1/* on some tenants
//   and /api/v1/payout/* on others. Probe candidates on first call, cache
//   whichever returns non-404, and reuse for the rest of the process.
const PATH_CANDIDATES = {
  initiate: [
    "/payout/v1/initiate",
    "/api/v1/payout/initiate",
    "/api/v1/payout/request-payout",
  ],
  status: [
    "/payout/v1/status",
    "/api/v1/payout/status",
    "/api/v1/payout/get-status",
  ],
  balance: [
    // /api/v1/payout/check-balance is the live path (verified) — the
    // /payout/v1/balance variants from public docs return 404.
    "/api/v1/payout/check-balance",
    "/payout/v1/balance",
    "/api/v1/payout/balance",
  ],
};
const resolvedPaths = {};   // memoised per process

// ─── HTTP wrappers ──────────────────────────────────────────────────────────
async function paywizePostEncrypted(kind, payloadObj) {
  const token   = await getAccessToken();
  const payload = encrypt(payloadObj, config.paywize.secretKey);

  const tryPath = async (path) => {
    const res = await call({
      method:  "POST",
      url:     `${config.paywize.baseUrl}${path}`,
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${token}`,
      },
      data:    { payload },
    });
    return { path, res };
  };

  // Fast path: we've already resolved this kind.
  if (resolvedPaths[kind]) {
    const { path, res } = await tryPath(resolvedPaths[kind]);
    if (!res.ok) {
      const bodyDump = res.body
        ? (typeof res.body === "object" ? JSON.stringify(res.body) : String(res.body))
        : (res.error || "no body");
      logger.warn("Paywize POST non-2xx (cached path)", {
        path, status: res.status, body: bodyDump.slice(0, 500),
      });
    }
    const decrypted = res.body?.data
      ? tryDecryptToObject(res.body.data, config.paywize.secretKey)
      : null;
    return { ...res, decrypted, path };
  }

  // Discovery path: walk candidates, skip 404s, lock in the first non-404 hit.
  const candidates = PATH_CANDIDATES[kind] || [kind];
  let lastNon404 = null;
  for (const path of candidates) {
    const { res } = await tryPath(path);
    if (res.status === 404) continue;
    resolvedPaths[kind] = path;
    logger.info("Paywize endpoint resolved", { kind, path, status: res.status });
    if (!res.ok) {
      const bodyDump = res.body
        ? (typeof res.body === "object" ? JSON.stringify(res.body) : String(res.body))
        : (res.error || "no body");
      logger.warn("Paywize POST non-2xx", {
        path, status: res.status, body: bodyDump.slice(0, 500),
      });
    }
    const decrypted = res.body?.data
      ? tryDecryptToObject(res.body.data, config.paywize.secretKey)
      : null;
    return { ...res, decrypted, path };
  }

  // Every candidate returned 404 — produce an actionable error.
  const tried = candidates.join(", ");
  logger.error("Paywize endpoint discovery failed — every candidate 404'd", {
    kind, tried,
  });
  return {
    ok:     false,
    status: 404,
    body:   { message: `no live path among: ${tried}` },
    decrypted: null,
    path:   null,
  };
}

async function paywizeGet(kind, params = {}) {
  const token = await getAccessToken();

  const tryPath = async (path) => {
    const res = await call({
      method:  "GET",
      url:     `${config.paywize.baseUrl}${path}`,
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${token}`,
      },
      params,
    });
    return { path, res };
  };

  const consume = (res, path) => {
    let decrypted = null;
    if (res.body?.data) {
      decrypted = typeof res.body.data === "string"
        ? tryDecryptToObject(res.body.data, config.paywize.secretKey)
        : res.body.data;
    } else if (res.body && typeof res.body === "object" && !res.body.resp_code && !res.body.respCode) {
      decrypted = res.body;
    }
    return { ...res, decrypted, path };
  };

  // Fast path: cached.
  if (resolvedPaths[kind]) {
    const { path, res } = await tryPath(resolvedPaths[kind]);
    return consume(res, path);
  }

  // Discovery: first non-404 wins.
  const candidates = PATH_CANDIDATES[kind] || [kind];
  for (const path of candidates) {
    const { res } = await tryPath(path);
    if (res.status === 404) continue;
    resolvedPaths[kind] = path;
    logger.info("Paywize endpoint resolved", { kind, path, status: res.status });
    return consume(res, path);
  }

  const tried = candidates.join(", ");
  logger.error("Paywize endpoint discovery failed — every candidate 404'd", {
    kind, tried,
  });
  return {
    ok:     false,
    status: 404,
    body:   { message: `no live path among: ${tried}` },
    decrypted: null,
    path:   null,
  };
}

// ─── Status mapper (Paywize statuses → our normalised form) ──────────────────
//   INITIATED / PROCESSING → PENDING
//   SUCCESS                → SUCCESS
//   FAILED / REFUNDED      → FAILED
function mapStatus(paywizeStatus) {
  const s = String(paywizeStatus || "").toLowerCase();
  if (s === "success" || s === "completed") return "SUCCESS";
  if (s === "failed"  || s === "rejected"  || s === "reversed" || s === "refunded") return "FAILED";
  return "PENDING";
}

// ─── Entry point — provider contract: processPayment(payDetails, amountINR, orderNo)
async function processPayment(payDetails, amountINR, orderNo) {
  const gateResult = await runCommonPreflightGates({
    payDetails, amountINR, orderNo, providerName: PROVIDER,
  });
  if (gateResult) return gateResult;

  const senderId     = deterministicTransferId(orderNo);
  const modeDecision = await chooseTransferMode(amountINR);

  const safeName    = String(payDetails.accountName || "Seller")
    .replace(/[^A-Za-z\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const ifscNorm    = String(payDetails.ifscCode || "").trim().toUpperCase();
  const accountNorm = String(payDetails.accountNo || "").trim();

  logger.info("Paywize payout starting", {
    orderNo, amountINR, senderId, mode: modeDecision.mode, ...modeDecision.snapshot,
  });

  // Persist the deterministic sender_id ASAP so the webhook can find this
  // order even if the bot restarts between initiate and webhook delivery.
  orderDbService.updateOrder(orderNo, { payout_id: senderId });

  // ── Initiate ─────────────────────────────────────────────────────────────
  const initBody = {
    sender_id:              senderId,
    wallet_id:              config.paywize.walletId,
    amount:                 String(Number(amountINR).toFixed(2)),
    payment_mode:           modeDecision.mode,
    beneficiary_name:       safeName,
    beneficiary_ifsc:       ifscNorm,
    beneficiary_acc_number: accountNorm,
    // Paywize hard limit: 20 chars. orderNo alone can be 20 digits, so
    // prefer the trailing slice (most distinctive part) over the "Order " prefix.
    remarks:                `Ord${String(orderNo)}`.replace(/[^A-Za-z0-9]/g, "").slice(-20),
    // Per Paywize docs: no dashboard webhook config exists. The callback URL
    // is passed per-request and Paywize POSTs status updates here.
    callback_url:           config.paywize.callbackUrl,
  };

  // Log the full request body (without bank PII) so we can confirm
  // callback_url is actually being sent to Paywize. Many webhook-missing
  // issues turn out to be `callback_url: undefined` reaching the gateway.
  logger.info("Paywize initiate request body", {
    orderNo,
    sender_id:    initBody.sender_id,
    wallet_id:    initBody.wallet_id,
    amount:       initBody.amount,
    payment_mode: initBody.payment_mode,
    callback_url: initBody.callback_url || "(MISSING — webhook will NEVER fire)",
  });

  const initResp = await paywizePostEncrypted("initiate", initBody);

  // Log the decrypted Paywize response so we can verify Paywize accepted
  // the request AND whether it echoes back the callback_url it'll use.
  logger.info("Paywize initiate response", {
    orderNo,
    status:    initResp.status,
    respCode:  initResp.body?.resp_code ?? initResp.body?.respCode,
    respMsg:   initResp.body?.resp_message ?? initResp.body?.respMessage,
    decrypted: initResp.decrypted ? JSON.stringify(initResp.decrypted).slice(0, 400) : null,
  });

  // Duplicate sender_id (bot retry) → fall through to status polling.
  if (!initResp.ok) {
    const respCode = initResp.body?.resp_code ?? initResp.body?.respCode;
    const respMsg  = initResp.body?.resp_message || initResp.body?.respMessage || "";
    if (respCode !== 2000) {
      const dupHint = /duplicate|already|exists/i.test(String(respMsg));

      // ── Soft-fallback to manual for known-recoverable rejection codes ────
      // 4003 = below minimum payout — bot can't fix this, but the OPERATOR
      //   can pay the small amount manually. Don't cancel the Binance order.
      // 4004 = above max payout (forward-looking — Paywize uses similar codes)
      // 4005 = insufficient wallet balance
      const SOFT_REJECTS = new Set([4003, 4004, 4005]);
      if (SOFT_REJECTS.has(Number(respCode))) {
        logger.warn("Paywize rejected payout — falling back to manual", {
          orderNo, respCode, respMsg, amountINR,
        });
        return manual("provider_rejected", amountINR, payDetails, {
          providerCode: respCode,
          providerMsg:  respMsg,
        });
      }

      if (!dupHint) {
        throw new Error(`Paywize initiate failed [${initResp.status}/${respCode}]: ${
          respMsg || initResp.error || "unknown"
        }`);
      }
      logger.warn("Paywize initiate returned duplicate — proceeding to status poll", {
        orderNo, senderId,
      });
    }
  }

  let last       = initResp.decrypted || {};
  let lastStatus = String(last.status || "").toLowerCase();

  // ── Poll ─────────────────────────────────────────────────────────────────
  const DELAYS_MS = [1500, 1500, 2000, 2000, 3000, 3000, 4000, 5000, 5000, 6000, 6000, 8000, 8000, 10000, 10000];
  const isTerminal = (s) =>
    s === "success" || s === "completed"
 || s === "failed"  || s === "rejected"
 || s === "reversed" || s === "refunded";

  for (const wait of DELAYS_MS) {
    if (isTerminal(lastStatus) || last.utr_number) break;
    await new Promise(r => setTimeout(r, wait));
    const poll = await paywizeGet("status", { sender_id: senderId });
    if (poll.decrypted) last = poll.decrypted;
    lastStatus = String(last.status || "").toLowerCase();
  }

  if (lastStatus === "failed" || lastStatus === "rejected"
   || lastStatus === "reversed" || lastStatus === "refunded") {
    throw new Error(`Paywize payout ${lastStatus.toUpperCase()}: ${
      last.status_message || last.remarks || "n/a"
    }`);
  }

  const isSuccess = lastStatus === "success" || lastStatus === "completed"
                 || !!last.utr_number;

  logger.info("Paywize payout poll completed", {
    orderNo,
    transactionId: last.transaction_id || senderId,
    status:        lastStatus.toUpperCase() || "PENDING",
    utr:           last.utr_number || "(no UTR yet)",
    pending:       !isSuccess,
  });

  if (isSuccess) {
    return {
      // KEEP payoutId = senderId (our deterministic id). Paywize's
      // transaction_id is informational and goes into providerTxnId — the
      // webhook handler and background poll look orders up by senderId
      // (= orders.payout_id), so this MUST stay deterministic.
      payoutId:     senderId,
      providerTxnId: last.transaction_id || null,
      status:       "SUCCESS",
      mode:         modeDecision.mode,
      amount:       amountINR,
      utr:          last.utr_number,
      pending:      false,
    };
  }

  // Pending — webhook is preferred. But Paywize webhook delivery has been
  // unreliable in prod (no `paywize webhook received` log lines observed
  // despite confirmed-success payouts), so kick off a background poll that
  // keeps checking /payout/status every 30s for up to 15 min and drives
  // finalizePayoutSuccess/Failed when the status flips terminal. The webhook
  // and this background poll race; whichever wins first finalises the order
  // (idempotency guards inside finalizePayout* handle the race cleanly).
  startBackgroundStatusPoll({ orderNo, senderId, mode: modeDecision.mode });

  return {
    // KEEP payoutId = senderId. Both the webhook handler (which finds
    // the order via orders.payout_id = sender_id) and the background
    // status poll depend on this being deterministic.
    payoutId:      senderId,
    providerTxnId: last.transaction_id || null,
    transferId:    senderId,
    status:        "PENDING",
    mode:          modeDecision.mode,
    amount:        amountINR,
    utr:           null,
    pending:       true,
  };
}

// ─── Background poll — webhook delivery fallback ─────────────────────────────
//   Paywize webhook delivery isn't 100% reliable, so for every order that
//   returns pending, we spawn a fire-and-forget poll loop that runs for up
//   to 15 min at 30-sec intervals. Calls orderHandler.finalize* when status
//   flips terminal — same code path the webhook controller drives, so the
//   chat template / state transition is identical.
//
//   Concurrency: one poll task per senderId; duplicate triggers no-op.
const _backgroundPollsInflight = new Set();

function startBackgroundStatusPoll({ orderNo, senderId, mode }) {
  if (_backgroundPollsInflight.has(senderId)) return;
  _backgroundPollsInflight.add(senderId);

  const POLL_INTERVAL_MS = 30_000;
  const POLL_MAX_MS      = 15 * 60_000;        // 15 minutes
  const startedAt = Date.now();

  // Lazy-load to avoid circular require at module init.
  const { orderHandler } = require("../../bot/orderHandler");

  const tick = async () => {
    if (Date.now() - startedAt > POLL_MAX_MS) {
      logger.warn("Paywize background poll timed out — webhook never arrived", {
        orderNo, senderId, elapsedMs: Date.now() - startedAt,
      });
      _backgroundPollsInflight.delete(senderId);
      return;
    }

    try {
      const r = await paywizeGet("status", { sender_id: senderId });
      const status = String(r.decrypted?.status || "").toLowerCase();
      const utr    = r.decrypted?.utr_number || null;

      logger.info("Paywize background poll tick", {
        orderNo, senderId, status: status.toUpperCase() || "(none)", utr,
      });

      if ((status === "success" || status === "completed") && utr) {
        logger.info("Paywize background poll → SUCCESS — finalising", { orderNo, utr });
        _backgroundPollsInflight.delete(senderId);
        await orderHandler.finalizePayoutSuccess(orderNo, utr, mode);
        return;
      }
      if (status === "failed" || status === "rejected" || status === "reversed" || status === "refunded") {
        const reason = r.decrypted?.status_message || r.decrypted?.remarks || status.toUpperCase();
        logger.warn("Paywize background poll → FAILED — finalising", { orderNo, reason });
        _backgroundPollsInflight.delete(senderId);
        await orderHandler.finalizePayoutFailed(orderNo, reason);
        return;
      }
    } catch (e) {
      logger.warn("Paywize background poll tick threw — will retry", {
        orderNo, error: e.message,
      });
    }

    setTimeout(tick, POLL_INTERVAL_MS);
  };

  setTimeout(tick, POLL_INTERVAL_MS);
  logger.info("Paywize background poll started", {
    orderNo, senderId,
    intervalSec: POLL_INTERVAL_MS / 1000,
    maxMinutes:  POLL_MAX_MS / 60_000,
  });
}

// ─── Webhook signature verification ──────────────────────────────────────────
//   Header  : X-Paywize-Signature: sha256=<hex>
//   Compute : HMAC-SHA256(rawBody, secretKey), hex-encoded.
//
//   The webhookSecret from config falls back to secretKey if not separately
//   set — Paywize uses the same secret as the encryption key for signing.
function verifyWebhookSignature(rawBody, signatureHeader) {
  // Paywize official docs (https://paywize.in/api-docs/payout/webhook) are
  // VAGUE about which input is HMAC'd. Their own Node.js sample doesn't
  // verify signatures at all. So we try every plausible (input × secret)
  // combination and accept any match. The downstream code still requires
  // the encrypted `data` field to decrypt cleanly with secretKey — that's
  // the real auth gate, since only Paywize knows the secret.
  if (!signatureHeader) return false;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");

    // Header may be 'sha256=<hex>' or bare '<hex>'.
    let received = String(signatureHeader).trim();
    if (received.toLowerCase().startsWith("sha256=")) {
      received = received.slice(7);
    }

    // Pull the encrypted `data` field — Paywize might HMAC that, not the
    // whole body.
    let dataField = null;
    try { dataField = JSON.parse(body)?.data || null; } catch (_) {}

    const sk = config.paywize?.secretKey;
    const ak = config.paywize?.apiKey;
    const wh = config.paywize?.webhookSecret;
    const secrets = [wh, sk, ak].filter(Boolean);

    // Try inputs × secrets × encodings — first match wins.
    const inputs = [body];
    if (dataField) inputs.push(dataField);

    const safeEq = (a, b) => {
      if (!a || !b) return false;
      const aBuf = Buffer.from(a);
      const bBuf = Buffer.from(b);
      if (aBuf.length !== bBuf.length) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    };

    for (const secret of secrets) {
      for (const input of inputs) {
        const hex = crypto.createHmac("sha256", secret).update(input).digest("hex");
        const b64 = crypto.createHmac("sha256", secret).update(input).digest("base64");
        if (safeEq(hex, received) || safeEq(b64, received)) return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn("Paywize webhook signature verify threw", { error: err.message });
    return false;
  }
}

// ─── Webhook payload parser ──────────────────────────────────────────────────
//   Body shape:        { data: "<encrypted base64>" }
//   Decrypted shape:   { transaction_id, sender_id, wallet_id, amount,
//                        payment_mode, status, utr_number, status_message,
//                        beneficiary, timestamps }
function parseWebhookEvent(parsed) {
  if (!parsed) return {};

  // Webhook body shapes Paywize can send (live + documented variants):
  //   1. { data: "<encrypted base64>" }                      ← V2 docs example
  //   2. { data: { ...decrypted fields... } }                ← already JSON
  //   3. flat fields at root (legacy/test)                   ← no `data` wrapper
  let decrypted = null;
  if (parsed.data && typeof parsed.data === "string") {
    decrypted = tryDecryptToObject(parsed.data, config.paywize.secretKey);
  } else if (parsed.data && typeof parsed.data === "object") {
    decrypted = parsed.data;
  } else if (parsed.sender_id || parsed.transaction_id || parsed.status) {
    // Flat shape — Paywize sometimes sends decrypted fields at root in dev/staging.
    decrypted = parsed;
  }

  if (!decrypted || typeof decrypted !== "object") {
    logger.warn("Paywize parseWebhookEvent: could not decrypt/parse body", {
      bodyKeys: Object.keys(parsed),
      dataType: typeof parsed.data,
    });
    return {};
  }

  // Log the decrypted payload so prod can see EXACTLY what Paywize delivered.
  // Bank PII is bounded (account/IFSC redacted by upstream) so the dump is safe.
  logger.info("Paywize webhook payload decrypted", {
    transaction_id: decrypted.transaction_id,
    sender_id:      decrypted.sender_id,
    status:         decrypted.status,
    utr_number:     decrypted.utr_number,
    status_message: decrypted.status_message,
    amount:         decrypted.amount,
    payment_mode:   decrypted.payment_mode,
  });

  const rawStatus = String(decrypted.status || "").toUpperCase();
  return {
    eventType:     `paywize.${rawStatus.toLowerCase() || "unknown"}`,
    // sender_id is what the bot wrote into orders.payout_id at initiate time —
    // this is the ONLY field that joins the webhook to the in-bot order state.
    transferId:    decrypted.sender_id || null,
    cfTransferId:  decrypted.transaction_id || null,
    status:        mapStatus(decrypted.status),
    rawStatus,
    utr:           decrypted.utr_number || null,
    failureReason: decrypted.status_message || decrypted.remarks || null,
    referenceId:   decrypted.sender_id || null,
  };
}

module.exports = {
  name: PROVIDER,
  processPayment,
  verifyWebhookSignature,
  parseWebhookEvent,
  mapStatus,
  // Exported for the webhook controller's direct decrypt/parse needs
  decrypt,
  encrypt,
};
