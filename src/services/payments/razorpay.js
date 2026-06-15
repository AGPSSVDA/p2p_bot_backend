const crypto = require("crypto");
const { config } = require("../../config/config");
const logger = require("../../utils/logger");
const orderDbService = require("../orderDbService");
const {
  call,
  manual,
  deterministicTransferId,
  deterministicBeneficiaryId,
  chooseTransferMode,
  runCommonPreflightGates,
} = require("./common");

// ─────────────────────────────────────────────────────────────────────────────
//  RazorpayX Payouts provider
//
//  Docs:  https://razorpay.com/docs/api/x/
//  Auth:  HTTP Basic — KEY_ID:KEY_SECRET (base64-encoded in the Authorization
//         header). No bearer token, no expiry — credentials sent on every call.
//
//  Flow per payout:
//    1. Find-or-create Contact      (POST /v1/contacts)
//    2. Find-or-create FundAccount  (POST /v1/fund_accounts)
//    3. Create Payout               (POST /v1/payouts)
//    4. Poll                        (GET  /v1/payouts/:id)
//
//  Contact + FundAccount are de-duped via deterministic reference_id, so
//  repeat orders to the same seller reuse the same RZP entities — no extra
//  API calls after the first time.
//
//  Webhook auth: HMAC-SHA256 of raw body with RAZORPAY_WEBHOOK_SECRET,
//  header `x-razorpay-signature` (case-insensitive).
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER = "razorpay";
const RZP_BASE = "https://api.razorpay.com/v1";

function authHeader() {
  const token = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString("base64");
  return {
    "Content-Type":  "application/json",
    Authorization:   `Basic ${token}`,
  };
}

// RazorpayX modes are lowercase in their API ("IMPS" → "IMPS" works too in
// most cases but lowercase is what their docs use). Keep uppercase for
// clarity in our chooseTransferMode contract; RZP accepts both.
function rzpMode(mode) {
  return String(mode || "IMPS").toUpperCase();
}

// ─── Contact (the seller as a RazorpayX entity) ──────────────────────────────
//   reference_id is our deterministic id, so the same seller across orders
//   maps to the same RZP contact. RZP returns 409 if the reference_id is
//   already used — we GET-by-reference_id and reuse on conflict.
async function findOrCreateContact({ payDetails, orderNo }) {
  const referenceId = `c_${crypto.createHash("sha256")
    .update(`contact|${payDetails.accountNo}|${String(payDetails.ifscCode).toUpperCase()}`)
    .digest("hex").slice(0, 24)}`;
  const safeName = String(payDetails.accountName || "Seller")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  // Try find first — saves a 409 + retry.
  const find = await call({
    method: "GET",
    url:    `${RZP_BASE}/contacts`,
    headers: authHeader(),
    params: { reference_id: referenceId, count: 1 },
  });
  if (find.ok && Array.isArray(find.body?.items) && find.body.items.length > 0) {
    logger.debug("RazorpayX contact reused", { orderNo, contactId: find.body.items[0].id });
    return find.body.items[0].id;
  }

  // Not found — create.
  const create = await call({
    method:  "POST",
    url:     `${RZP_BASE}/contacts`,
    headers: authHeader(),
    data: {
      name:         safeName,
      type:         "vendor",
      reference_id: referenceId,
      notes:        { source: "p2p-bot" },
    },
  });
  if (create.ok && create.body?.id) {
    logger.info("RazorpayX contact created", { orderNo, contactId: create.body.id });
    return create.body.id;
  }
  throw new Error(`RazorpayX contact create failed [${create.status}]: ${
    create.body?.error?.description || create.error || "unknown"
  }`);
}

// ─── Fund Account (the seller's bank account linked to a Contact) ────────────
//   Same de-dup pattern via deterministic note.
async function findOrCreateFundAccount({ contactId, payDetails, orderNo }) {
  const accountNumber = String(payDetails.accountNo).trim();
  const ifsc          = String(payDetails.ifscCode).trim().toUpperCase();
  const safeName      = String(payDetails.accountName || "Seller")
    .replace(/[^A-Za-z\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);

  // List existing fund_accounts for the contact, look for one matching this
  // account+ifsc. RZP doesn't expose a reference_id field on fund_accounts,
  // so list + match locally.
  const find = await call({
    method:  "GET",
    url:     `${RZP_BASE}/fund_accounts`,
    headers: authHeader(),
    params:  { contact_id: contactId, account_type: "bank_account", count: 20 },
  });
  if (find.ok && Array.isArray(find.body?.items)) {
    const match = find.body.items.find(fa =>
      fa.bank_account?.account_number === accountNumber &&
      String(fa.bank_account?.ifsc || "").toUpperCase() === ifsc
    );
    if (match) {
      logger.debug("RazorpayX fund_account reused", { orderNo, fundAccountId: match.id });
      return match.id;
    }
  }

  // Create new.
  const create = await call({
    method:  "POST",
    url:     `${RZP_BASE}/fund_accounts`,
    headers: authHeader(),
    data: {
      contact_id:   contactId,
      account_type: "bank_account",
      bank_account: {
        name:           safeName,
        ifsc,
        account_number: accountNumber,
      },
    },
  });
  if (create.ok && create.body?.id) {
    logger.info("RazorpayX fund_account created", { orderNo, fundAccountId: create.body.id });
    return create.body.id;
  }
  throw new Error(`RazorpayX fund_account create failed [${create.status}]: ${
    create.body?.error?.description || create.error || "unknown"
  }`);
}

// ─── Initiate a payout ───────────────────────────────────────────────────────
async function initiatePayout({ fundAccountId, amountINR, mode, referenceId, orderNo }) {
  const payload = {
    account_number:        config.razorpay.accountNumber, // the RZP virtual account that funds the payout
    fund_account_id:       fundAccountId,
    amount:                Math.round(Number(amountINR) * 100), // paise
    currency:              "INR",
    mode:                  rzpMode(mode),
    purpose:               "payout",
    queue_if_low_balance:  true,
    reference_id:          referenceId,
    narration:             `Order ${String(orderNo)}`.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 30),
  };
  // X-Payout-Idempotency lets RZP dedupe retries — use the same deterministic id.
  const headers = { ...authHeader(), "X-Payout-Idempotency": referenceId };
  return call({ method: "POST", url: `${RZP_BASE}/payouts`, headers, data: payload });
}

async function getPayout(payoutId) {
  return call({
    method:  "GET",
    url:     `${RZP_BASE}/payouts/${encodeURIComponent(payoutId)}`,
    headers: authHeader(),
  });
}

// RazorpayX statuses we treat as terminal-success / terminal-failure / pending.
// Reference: https://razorpay.com/docs/api/x/payouts/#payout-status-life-cycle
const TERMINAL_SUCCESS = new Set(["processed"]);
const TERMINAL_FAILURE = new Set(["reversed", "cancelled", "failed", "rejected"]);

// Status mapper exported for the webhook controller.
function mapStatus(rzpStatus) {
  const s = String(rzpStatus || "").toLowerCase();
  if (TERMINAL_SUCCESS.has(s)) return "SUCCESS";
  if (TERMINAL_FAILURE.has(s)) return "FAILED";
  return "PENDING";
}

// ─── Entry point — provider contract: processPayment(payDetails, amountINR, orderNo)
async function processPayment(payDetails, amountINR, orderNo) {
  const gateResult = await runCommonPreflightGates({
    payDetails, amountINR, orderNo, providerName: PROVIDER,
  });
  if (gateResult) return gateResult;

  const referenceId  = deterministicTransferId(orderNo);
  const modeDecision = await chooseTransferMode(amountINR);

  logger.info("RazorpayX payout starting", {
    orderNo, amountINR, referenceId, mode: modeDecision.mode, ...modeDecision.snapshot,
  });

  // Build the contact + fund_account (cached server-side via reference_id +
  // contact_id list-match — we don't need a local cache table).
  let contactId, fundAccountId;
  try {
    contactId      = await findOrCreateContact({ payDetails, orderNo });
    fundAccountId  = await findOrCreateFundAccount({ contactId, payDetails, orderNo });
  } catch (err) {
    throw new Error(`RazorpayX setup failed: ${err.message}`);
  }

  // Create the payout
  const xferResp = await initiatePayout({
    fundAccountId, amountINR, mode: modeDecision.mode, referenceId, orderNo,
  });

  // Idempotency: if RZP rejected with BAD_REQUEST_DUPLICATE_PAYOUT_REQUEST,
  // we can fetch the existing payout by reference_id.
  let payout = null;
  if (xferResp.ok && xferResp.body?.id) {
    payout = xferResp.body;
  } else if (xferResp.body?.error?.code === "BAD_REQUEST_ERROR"
          && /duplicate/i.test(String(xferResp.body?.error?.description || ""))) {
    logger.warn("RazorpayX duplicate payout — fetching existing", { orderNo, referenceId });
    const list = await call({
      method:  "GET",
      url:     `${RZP_BASE}/payouts`,
      headers: authHeader(),
      params:  { reference_id: referenceId, account_number: config.razorpay.accountNumber, count: 1 },
    });
    if (list.ok && list.body?.items?.length) payout = list.body.items[0];
  }
  if (!payout) {
    throw new Error(`RazorpayX initiatePayout failed [${xferResp.status}]: ${
      xferResp.body?.error?.description || xferResp.error || "unknown"
    }`);
  }

  // Persist our deterministic payout_id ASAP so the webhook can find this order.
  orderDbService.updateOrder(orderNo, { payout_id: payout.id });

  // ── Poll ────────────────────────────────────────────────────────────────
  const DELAYS_MS = [1500, 1500, 2000, 2000, 3000, 3000, 4000, 5000, 5000, 6000, 6000, 8000, 8000, 10000, 10000];
  let last = payout;
  for (const wait of DELAYS_MS) {
    const s = String(last.status || "").toLowerCase();
    if (TERMINAL_SUCCESS.has(s) || TERMINAL_FAILURE.has(s) || last.utr) break;
    await new Promise(r => setTimeout(r, wait));
    const poll = await getPayout(payout.id);
    if (poll.ok && poll.body) last = poll.body;
  }

  const status = String(last.status || "").toLowerCase();
  if (TERMINAL_FAILURE.has(status)) {
    throw new Error(`RazorpayX payout ${status.toUpperCase()}: ${last.failure_reason || last.error?.description || "n/a"}`);
  }

  const isSuccess = TERMINAL_SUCCESS.has(status) || !!last.utr;

  logger.info("RazorpayX payout poll completed", {
    orderNo, payoutId: last.id, status: status.toUpperCase(),
    utr: last.utr || "(no UTR yet)", pending: !isSuccess,
  });

  if (isSuccess) {
    return {
      payoutId: String(last.id),
      status:   "SUCCESS",
      mode:     modeDecision.mode,
      amount:   amountINR,
      utr:      last.utr,
      pending:  false,
    };
  }

  // Pending — webhook will resolve to success/failed later.
  return {
    payoutId:   String(last.id),
    transferId: String(last.id),
    status:     "PENDING",
    mode:       modeDecision.mode,
    amount:     amountINR,
    utr:        null,
    pending:    true,
  };
}

// ─── Webhook signature verification ──────────────────────────────────────────
//   Razorpay signs the RAW request body (no timestamp prefix, unlike CF v2).
//   Reference: https://razorpay.com/docs/webhooks/validate-test/
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !config.razorpay?.webhookSecret) return false;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    const expected = crypto
      .createHmac("sha256", config.razorpay.webhookSecret)
      .update(body)
      .digest("hex");           // RZP signature is hex, NOT base64
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(String(signatureHeader));
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    logger.warn("RazorpayX webhook signature verify threw", { error: err.message });
    return false;
  }
}

// Extract our normalised event shape from a RZP webhook payload.
//   Events of interest: payout.processed, payout.failed, payout.reversed
function parseWebhookEvent(parsed) {
  const eventType = String(parsed?.event || "").toLowerCase();
  const payout    = parsed?.payload?.payout?.entity || parsed?.payload?.payout || parsed?.payload || {};

  return {
    eventType,
    transferId:     payout.id || null,           // matches what we stored in orders.payout_id
    cfTransferId:   payout.id || null,
    status:         mapStatus(payout.status),
    rawStatus:      String(payout.status || "").toUpperCase(),
    utr:            payout.utr || null,
    failureReason:  payout.failure_reason || payout.error?.description || null,
    referenceId:    payout.reference_id || null,
  };
}

module.exports = {
  name: PROVIDER,
  processPayment,
  verifyWebhookSignature,
  parseWebhookEvent,
  mapStatus,
};
