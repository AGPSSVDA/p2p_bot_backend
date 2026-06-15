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

// ─── AES-256-GCM helpers (V2) ────────────────────────────────────────────────
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

function decrypt(encryptedData, secretKey) {
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

// Convenience: decrypt a possibly-encrypted JSON `data` field. Accepts already-
// decoded objects too (some responses return data unencrypted on auth/balance).
function tryDecryptToObject(maybeEncrypted, secretKey) {
  if (!maybeEncrypted) return null;
  if (typeof maybeEncrypted === "object") return maybeEncrypted;
  try {
    const plain = decrypt(maybeEncrypted, secretKey);
    try { return JSON.parse(plain); } catch (_) { return plain; }
  } catch (err) {
    logger.warn("Paywize decrypt failed", { error: err.message });
    return null;
  }
}

// ─── Auth token cache (5-min TTL per docs, refresh 30s early) ────────────────
let tokenCache = { value: null, expiresAtMs: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAtMs - 30_000) {
    return tokenCache.value;
  }
  // Auth body is itself encrypted in V2.
  const payload = encrypt(
    { apiKey: config.paywize.apiKey, secretKey: config.paywize.secretKey },
    config.paywize.secretKey,
  );
  const res = await call({
    method:  "POST",
    url:     `${config.paywize.baseUrl}/api/v1/auth/clients/token`,
    headers: { "Content-Type": "application/json" },
    data:    { payload },
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

  // The `data` field is encrypted; decrypt it to extract { token }.
  let token = null;
  const dataField = res.body?.data;
  if (typeof dataField === "string") {
    const decoded = tryDecryptToObject(dataField, config.paywize.secretKey);
    token = decoded?.token || (typeof decoded === "string" ? decoded : null);
  } else if (dataField && typeof dataField === "object") {
    token = dataField.token || null;
  }

  if (!token) {
    throw new Error(`Paywize token fetch — could not extract JWT (respCode=${
      res.body?.respCode ?? res.body?.resp_code ?? "?"
    })`);
  }

  const ttlSec = Number(res.body?.expiresIn) || 300;
  tokenCache = {
    value:       token,
    expiresAtMs: Date.now() + (ttlSec * 1000),
  };
  logger.info("Paywize token acquired", { ttlSec });
  return token;
}

// ─── HTTP wrappers ──────────────────────────────────────────────────────────
async function paywizePostEncrypted(path, payloadObj) {
  const token   = await getAccessToken();
  const payload = encrypt(payloadObj, config.paywize.secretKey);
  const res = await call({
    method:  "POST",
    url:     `${config.paywize.baseUrl}${path}`,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
    },
    data:    { payload },
  });
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
  return { ...res, decrypted };
}

async function paywizeGet(path, params = {}) {
  const token = await getAccessToken();
  const res = await call({
    method:  "GET",
    url:     `${config.paywize.baseUrl}${path}`,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
    },
    params,
  });
  // `data` field may be encrypted string OR a plain object depending on the
  // endpoint. Handle both shapes.
  let decrypted = null;
  if (res.body?.data) {
    decrypted = typeof res.body.data === "string"
      ? tryDecryptToObject(res.body.data, config.paywize.secretKey)
      : res.body.data;
  } else if (res.body && typeof res.body === "object" && !res.body.resp_code && !res.body.respCode) {
    decrypted = res.body;
  }
  return { ...res, decrypted };
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
    remarks:                `Order ${String(orderNo)}`.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 70),
    // Per Paywize docs: no dashboard webhook config exists. The callback URL
    // is passed per-request and Paywize POSTs status updates here.
    callback_url:           config.paywize.callbackUrl,
  };

  const initResp = await paywizePostEncrypted("/api/v1/payout/initiate", initBody);

  // Duplicate sender_id (bot retry) → fall through to status polling.
  if (!initResp.ok) {
    const respCode = initResp.body?.resp_code ?? initResp.body?.respCode;
    const respMsg  = initResp.body?.resp_message || initResp.body?.respMessage || "";
    if (respCode !== 2000) {
      const dupHint = /duplicate|already|exists/i.test(String(respMsg));
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
    const poll = await paywizeGet("/api/v1/payout/status", { sender_id: senderId });
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
      payoutId: String(last.transaction_id || senderId),
      status:   "SUCCESS",
      mode:     modeDecision.mode,
      amount:   amountINR,
      utr:      last.utr_number,
      pending:  false,
    };
  }

  // Pending — the webhook will resolve to success or failed later.
  return {
    payoutId:   String(last.transaction_id || senderId),
    transferId: senderId,
    status:     "PENDING",
    mode:       modeDecision.mode,
    amount:     amountINR,
    utr:        null,
    pending:    true,
  };
}

// ─── Webhook signature verification ──────────────────────────────────────────
//   Header  : X-Paywize-Signature: sha256=<hex>
//   Compute : HMAC-SHA256(rawBody, secretKey), hex-encoded.
//
//   The webhookSecret from config falls back to secretKey if not separately
//   set — Paywize uses the same secret as the encryption key for signing.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = config.paywize?.webhookSecret || config.paywize?.secretKey;
  if (!signatureHeader || !secret) return false;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");

    // Header value is `sha256=<hex>` per docs. Strip the prefix; some
    // gateways/proxies may forward without it, so be defensive.
    let received = String(signatureHeader).trim();
    if (received.toLowerCase().startsWith("sha256=")) {
      received = received.slice(7);
    }

    const expectedHex = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const expectedB64 = crypto.createHmac("sha256", secret).update(body).digest("base64");

    const safeEq = (a, b) => {
      const aBuf = Buffer.from(a);
      const bBuf = Buffer.from(b);
      if (aBuf.length !== bBuf.length) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    };
    // Accept hex (docs-correct) or base64 (some merchant-account variants).
    return safeEq(expectedHex, received) || safeEq(expectedB64, received);
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
  const decrypted = parsed.data
    ? (typeof parsed.data === "string"
        ? tryDecryptToObject(parsed.data, config.paywize.secretKey)
        : parsed.data)
    : parsed;

  if (!decrypted || typeof decrypted !== "object") return {};

  const rawStatus = String(decrypted.status || "").toUpperCase();
  return {
    eventType:     `paywize.${rawStatus.toLowerCase() || "unknown"}`,
    transferId:    decrypted.sender_id || null,         // matches orders.payout_id
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
