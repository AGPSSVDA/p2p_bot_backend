const crypto = require("crypto");
const { pool } = require("../config/mysql");
const { config } = require("../config/config");
const { stateManager, ORDER_STATE } = require("../bot/stateManager");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Cashfree Payouts webhook receiver
//
//  Cashfree pushes a POST to whichever URL is registered at
//    Dashboard → Payouts → Developers → Webhooks
//  the moment the partner bank confirms (or rejects) a transfer.
//
//  Signature: HMAC-SHA256(body, CF_CLIENT_SECRET) — sent in
//    `x-webhook-signature` header (base64-encoded).
//
//  Body shape (simplified — Cashfree includes more):
//    {
//      "event": "TRANSFER_SUCCESS" | "TRANSFER_FAILED" | "TRANSFER_REVERSED" | …,
//      "data":  { "transfer": {
//          "transfer_id":      "tx_…",      ← our deterministic id
//          "cf_transfer_id":   "12345678",  ← Cashfree's internal id
//          "status":           "SUCCESS",
//          "transfer_utr":     "0123456789",
//          "failure_reason":   "…",
//      } }
//    }
//
//  We look up the order by transfer_id (which we wrote into orders.payout_id
//  before polling) and update orders + payouts. The bot's state machine
//  isn't driven by this webhook — order COMPLETED still comes from Binance's
//  order_status push when the seller releases crypto. The webhook just
//  speeds up our knowledge of payout-side outcomes (UTR / failures).
// ─────────────────────────────────────────────────────────────────────────────

// Verify HMAC-SHA256 of the raw body against the signature header.
function verifySignature(rawBody, signature) {
  if (!signature || !config.cashfree.clientSecret) return false;
  try {
    const expected = crypto
      .createHmac("sha256", config.cashfree.clientSecret)
      .update(rawBody)
      .digest("base64");
    const expectedBuf  = Buffer.from(expected);
    const receivedBuf  = Buffer.from(String(signature));
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    logger.warn("Cashfree webhook signature verify threw", { error: err.message });
    return false;
  }
}

// Extract { transfer_id, cf_transfer_id, status, transfer_utr, failure_reason }
// from a parsed webhook body, defensively handling field variants.
function extractTransfer(parsed) {
  const t = parsed?.data?.transfer || parsed?.data || parsed || {};
  return {
    transfer_id:    t.transfer_id    || null,
    cf_transfer_id: t.cf_transfer_id || null,
    status:         String(t.status || "").toUpperCase(),
    transfer_utr:   t.transfer_utr   || null,
    failure_reason: t.failure_reason || t.reason || null,
  };
}

// Map Cashfree transfer status → our payouts.status.
function mapToPayoutStatus(cfStatus) {
  switch ((cfStatus || "").toUpperCase()) {
    case "SUCCESS":
    case "COMPLETED":
      return "SUCCESS";
    case "FAILED":
    case "REJECTED":
    case "MANUALLY_REJECTED":
    case "REVERSED":
      return "FAILED";
    default:
      return "PENDING";
  }
}

// ── POST /api/cashfree/webhook ──────────────────────────────────────────────
async function handleWebhook(req, res) {
  // Always 200 to Cashfree so they don't retry forever — even if we drop
  // the event, the bot's polling fallback still picks up the UTR. We log
  // every event for debug.
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  const signature = req.headers["x-webhook-signature"] || "";
  const verified  = verifySignature(rawBody, signature);

  let parsed = null;
  try { parsed = JSON.parse(rawBody); } catch (_) {}

  const evt = extractTransfer(parsed || {});
  const eventType = String(parsed?.event || parsed?.type || "").toUpperCase();

  logger.info("Cashfree webhook received", {
    event:          eventType || "(no event field)",
    verified,
    transfer_id:    evt.transfer_id    || "(missing)",
    cf_transfer_id: evt.cf_transfer_id || "(missing)",
    status:         evt.status         || "(unknown)",
    utr:            evt.transfer_utr   || "(none)",
  });

  // If signature is bad, log loudly but still ack — failed signature is
  // usually a misconfigured secret on Cashfree's side, not a hostile call,
  // and we don't want them retrying.
  if (!verified) {
    logger.warn("Cashfree webhook signature INVALID — refusing to apply", {
      transfer_id: evt.transfer_id || "(missing)",
    });
    return res.status(200).json({ ok: false, reason: "signature_invalid" });
  }

  if (!evt.transfer_id) {
    return res.status(200).json({ ok: false, reason: "no_transfer_id" });
  }

  try {
    // Find the order by our transfer_id (saved at initiate time into
    // orders.payout_id). Falls back to a LIKE on the transient PEND-* utr
    // we set on the orders row when polling didn't yield a real UTR yet.
    const [orderRows] = await pool.query(
      `SELECT order_no, state, payout_id, utr_number
         FROM orders
        WHERE payout_id = ?
           OR utr_number = ?
        LIMIT 1`,
      [evt.transfer_id, `PEND-${evt.transfer_id}`]
    );
    const order = orderRows[0];

    if (!order) {
      logger.warn("Cashfree webhook: no matching order found", {
        transfer_id: evt.transfer_id,
      });
      return res.status(200).json({ ok: false, reason: "order_not_found" });
    }

    const orderNo = order.order_no;
    const payoutStatus = mapToPayoutStatus(evt.status);

    // Update the orders row with real UTR (only if we don't have a real one yet).
    const haveRealUtr = order.utr_number && !String(order.utr_number).startsWith("PEND-");
    const orderPatch = {};
    if (evt.transfer_utr && !haveRealUtr) {
      orderPatch.utr_number = evt.transfer_utr;
    }
    if (evt.cf_transfer_id) {
      // Keep our transfer_id as the primary id; cf_transfer_id is informational
      // for now (could promote to a new column if needed).
    }
    if (Object.keys(orderPatch).length) {
      await pool.query(
        `UPDATE orders SET ${Object.keys(orderPatch).map((k) => `${k} = ?`).join(", ")} WHERE order_no = ?`,
        [...Object.values(orderPatch), orderNo]
      );
    }

    // Update the payouts row.
    await pool.query(
      `UPDATE payouts
          SET status = ?,
              utr_number = COALESCE(?, utr_number)
        WHERE order_id = ?`,
      [payoutStatus, evt.transfer_utr || null, orderNo]
    );

    // On hard failure, move the order to FAILED (only if still mid-flow).
    // SUCCESS doesn't move the state — the order stays in WAITING_FOR_RELEASE
    // until the seller releases crypto on Binance.
    if (payoutStatus === "FAILED") {
      const safeToFailStates = [
        ORDER_STATE.PROCESSING_PAYMENT,
        ORDER_STATE.PAYMENT_SENT,
        ORDER_STATE.WAITING_FOR_RELEASE,
        ORDER_STATE.AWAITING_MANUAL_PAYMENT,
      ];
      if (safeToFailStates.includes(order.state)) {
        const live = stateManager.get(orderNo);
        if (live) {
          stateManager.set(orderNo, ORDER_STATE.FAILED, {
            cancel_reason: `Cashfree payout ${evt.status}: ${evt.failure_reason || "n/a"}`,
          });
        } else {
          await pool.query(
            `UPDATE orders
                SET state = 'FAILED',
                    cancel_reason = ?
              WHERE order_no = ?`,
            [
              `Cashfree payout ${evt.status}: ${evt.failure_reason || "n/a"}`,
              orderNo,
            ]
          );
        }
        logger.error("Cashfree payout FAILED — order moved to FAILED state", {
          orderNo, transfer_id: evt.transfer_id, reason: evt.failure_reason,
        });
      }
    }

    // Mirror UTR into the in-memory state if the bot is still tracking
    // this order — keeps things consistent if the bot sends any later chat.
    if (evt.transfer_utr) {
      const live = stateManager.get(orderNo);
      if (live && !live.utr) {
        stateManager.set(orderNo, live.state, { utr: evt.transfer_utr });
      }
    }

    logger.info("Cashfree webhook applied", {
      orderNo,
      transfer_id:   evt.transfer_id,
      newStatus:     payoutStatus,
      utr:           evt.transfer_utr || "(unchanged)",
    });

    return res.status(200).json({ ok: true, orderNo, status: payoutStatus });
  } catch (err) {
    logger.error("Cashfree webhook handler failed", {
      transfer_id: evt.transfer_id,
      error:       err.message,
    });
    // Still 200 — repeated retries from Cashfree won't help if our DB is down
    return res.status(200).json({ ok: false, reason: "internal_error" });
  }
}

module.exports = { handleWebhook };
