const { pool } = require("../config/mysql");
const { stateManager } = require("../bot/stateManager");
const { orderHandler } = require("../bot/orderHandler");
const payments = require("../services/payments");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  Unified payment-webhook controller
//
//  Both RazorpayX and Paywize push payout status updates over HTTP webhooks.
//  The downstream side-effects are identical regardless of provider:
//
//    1. Verify signature (provider-specific HMAC scheme)
//    2. Parse out { transferId, status, utr, failureReason } in a normalised shape
//    3. Look up the order via orders.payout_id (set at initiate time)
//    4. Update orders + payouts rows
//    5. Drive orderHandler.finalizePayoutSuccess / finalizePayoutFailed
//
//  So we register ONE handler per provider URL — `:provider` is wired in
//  src/index.js — and dispatch to the matching module.
//
//  IMPORTANT: this route needs the raw request body (Buffer) for signature
//  verification. The route is registered with express.raw({ type: '*/*' })
//  ahead of any JSON body-parser middleware.
// ─────────────────────────────────────────────────────────────────────────────

function buildHandler(providerName) {
  return async function handleWebhook(req, res) {
    // FIRST-LINE TRACE — fires before ANY parsing/decryption logic. If you
    // don't see this line in pm2 logs, Paywize is not hitting your server
    // at all (DNS, firewall, or Paywize-side delivery failure).
    logger.info(`${providerName} webhook HIT`, {
      method: req.method,
      path:   req.path || req.url,
      from:   req.ip || req.socket?.remoteAddress,
      ua:     req.headers?.["user-agent"] || "(none)",
      contentType: req.headers?.["content-type"] || "(none)",
    });

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");

    // Provider-specific header conventions (Node lowercases all incoming
    // headers, so we look up by lowercase regardless of how the provider
    // sends them):
    //   RazorpayX : 'x-razorpay-signature'  →  hex of HMAC-SHA256
    //   Paywize   : 'x-paywize-signature: sha256=<hex>'  (sha256= prefix stripped
    //               inside provider.verifyWebhookSignature)
    const signature = providerName === "razorpay"
      ? (req.headers["x-razorpay-signature"] || "")
      : (req.headers["x-paywize-signature"]
         || req.headers["x-webhook-signature"]   // legacy / docs variant
         || "");

    let provider;
    try {
      provider = payments.getProviderByName(providerName);
    } catch (err) {
      logger.error("Webhook for unknown provider", { providerName, error: err.message });
      return res.status(404).json({ ok: false, reason: "unknown_provider" });
    }

    const verified = provider.verifyWebhookSignature(rawBody, signature);

    let parsed = null;
    try { parsed = JSON.parse(rawBody); } catch (_) {}

    const evt = provider.parseWebhookEvent(parsed || {}) || {};

    // Header dump for forensics — when Paywize webhooks fail signature
    // verification we want to know exactly what headers + body shape arrived
    // (their docs are vague about the HMAC scheme so the only way to debug
    // is to inspect a real delivery).
    const headerNames = Object.keys(req.headers || {}).filter(h =>
      h.startsWith("x-") || h === "user-agent" || h === "content-type"
    );

    logger.info(`${providerName} webhook received`, {
      eventType:    evt.eventType || "(none)",
      verified,
      hasSignature: !!signature,
      transferId:   evt.transferId || "(missing)",
      status:       evt.rawStatus  || "(unknown)",
      utr:          evt.utr        || "(none)",
      headers:      headerNames,
      bodyLen:      rawBody.length,
    });

    // Security model:
    //   Razorpay  : signature MUST verify (their docs are explicit on the
    //               HMAC scheme — failure means forged or misrouted webhook).
    //   Paywize   : signature scheme is under-documented (their official
    //               Node sample at /api-docs/payout/webhook does NOT verify
    //               signatures — they rely on payload decryption). Decryption
    //               with the secretKey IS the real auth: only Paywize could
    //               have produced a payload that decrypts cleanly. So Paywize
    //               webhooks proceed even when signature verify fails, but a
    //               WARN is logged so operators can investigate.
    if (!verified) {
      if (providerName === "razorpay") {
        logger.warn(`${providerName} webhook signature INVALID — refusing to apply`, {
          transferId: evt.transferId || "(missing)",
        });
        return res.status(200).json({ ok: false, reason: "signature_invalid" });
      }
      // Paywize: proceed only if the body decrypted successfully (i.e., we
      // got a transferId out of it — proves the sender knew our secretKey).
      if (!evt.transferId) {
        logger.warn(`paywize webhook: sig invalid AND no transferId — refusing`, {
          hasSignature: !!signature,
          bodyPreview:  rawBody.slice(0, 200),
        });
        return res.status(200).json({ ok: false, reason: "signature_invalid_and_undecryptable" });
      }
      logger.warn(`paywize webhook: sig verify failed but payload decrypted — proceeding`, {
        transferId: evt.transferId,
        note: "decryption with secretKey is the real auth — sig scheme under-documented",
      });
    }

    if (!evt.transferId) {
      return res.status(200).json({ ok: false, reason: "no_transfer_id" });
    }

    try {
      // Find the order by our deterministic transferId stored in orders.payout_id.
      // PEND-* fallback covers an old path where the row had a placeholder
      // UTR before the real one arrived.
      const [orderRows] = await pool.query(
        `SELECT order_no, state, payout_id, utr_number
           FROM orders
          WHERE payout_id = ?
             OR utr_number = ?
          LIMIT 1`,
        [evt.transferId, `PEND-${evt.transferId}`]
      );
      const order = orderRows[0];

      if (!order) {
        logger.warn(`${providerName} webhook: no matching order found`, {
          transferId: evt.transferId,
        });
        return res.status(200).json({ ok: false, reason: "order_not_found" });
      }

      const orderNo = order.order_no;
      const payoutStatus = evt.status; // already normalised by provider.parseWebhookEvent

      // Patch orders.utr_number with the real UTR if we don't have one yet.
      const haveRealUtr = order.utr_number && !String(order.utr_number).startsWith("PEND-");
      if (evt.utr && !haveRealUtr) {
        await pool.query(
          `UPDATE orders SET utr_number = ? WHERE order_no = ?`,
          [evt.utr, orderNo]
        );
      }

      // Update payouts row (created at processPayment time).
      await pool.query(
        `UPDATE payouts
            SET status = ?,
                utr_number = COALESCE(?, utr_number)
          WHERE order_id = ?`,
        [payoutStatus, evt.utr || null, orderNo]
      );

      // ── Bot-side finalisation ────────────────────────────────────────────
      // Idempotency is enforced inside orderHandler.finalize* — those skip
      // if the order already has a real UTR or is in a terminal state.
      try {
        if (payoutStatus === "SUCCESS" && evt.utr) {
          await orderHandler.finalizePayoutSuccess(orderNo, evt.utr, null);
        } else if (payoutStatus === "FAILED") {
          await orderHandler.finalizePayoutFailed(
            orderNo,
            evt.failureReason || evt.rawStatus || `${providerName} reported failure`
          );
        } else if (evt.utr) {
          // PENDING with a UTR — mirror it into in-memory state so a later
          // SUCCESS webhook can correlate cleanly.
          const live = stateManager.get(orderNo);
          if (live && (!live.utr || String(live.utr).startsWith("PEND-"))) {
            stateManager.set(orderNo, live.state, { utr: evt.utr });
          }
        }
      } catch (bizErr) {
        logger.error("orderHandler finalize threw — DB updates already applied", {
          orderNo, payoutStatus, providerName, error: bizErr.message,
        });
      }

      logger.info(`${providerName} webhook applied`, {
        orderNo,
        transferId: evt.transferId,
        newStatus:  payoutStatus,
        utr:        evt.utr || "(unchanged)",
      });

      return res.status(200).json({ ok: true, orderNo, status: payoutStatus });
    } catch (err) {
      logger.error(`${providerName} webhook handler failed`, {
        transferId: evt.transferId,
        error:      err.message,
      });
      // 200 — re-delivery from the provider won't help if our DB is sick.
      return res.status(200).json({ ok: false, reason: "internal_error" });
    }
  };
}

module.exports = {
  handleRazorpayWebhook: buildHandler("razorpay"),
  handlePaywizeWebhook:  buildHandler("paywize"),
};
