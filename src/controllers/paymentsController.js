const { pool } = require("../config/mysql");
const logger = require("../utils/logger");
const { markOrderAsPaid } = require("../services/binanceService");
const orderDb = require("../services/orderDbService");
const { stateManager, ORDER_STATE } = require("../bot/stateManager");

// ── GET /api/payments ────────────────────────────────────────────────────────
//   Returns payouts plus summary tiles (success / pending / failed counts).
async function listPayments(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (req.query.status) {
      where.push("status = ?");
      params.push(String(req.query.status).toUpperCase());
    }
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      where.push("(order_id LIKE ? OR pan_name LIKE ? OR seller_pan LIKE ? OR utr_number LIKE ?)");
      params.push(q, q, q, q);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRow] = await pool.query(
      `SELECT COUNT(*) AS total FROM payouts ${whereSql}`,
      params
    );
    const total = Number(countRow[0]?.total) || 0;

    const [rows] = await pool.query(
      `SELECT * FROM payouts ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const payments = rows.map((r) => ({
      id: `PAY-${String(r.id).padStart(5, "0")}`,
      payout_id: r.id,
      orderId: r.order_id,
      sellerName: r.pan_name,
      sellerPan: r.seller_pan,
      total_order_amount: Number(r.total_order_amount) || 0,
      tds_amount: Number(r.tds_amount) || 0,
      amount: Number(r.amount) || 0,
      utr: r.utr_number,
      upi: r.upi_id,
      method: r.payment_method,
      status: r.status,
      time: r.created_at,
    }));

    const [summaryRow] = await pool.query(`
      SELECT
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'FAILED'  THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'SUCCESS' THEN amount ELSE 0 END) AS success_amount,
        SUM(CASE WHEN status = 'PENDING' THEN amount ELSE 0 END) AS pending_amount
      FROM payouts
    `);
    const s = summaryRow[0] || {};

    const [cfgRow] = await pool.query(
      "SELECT auto_payout FROM bot_config ORDER BY id ASC LIMIT 1"
    );

    res.json({
      success: true,
      message: "Payments retrieved successfully",
      data: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        autoPayout: Number(cfgRow[0]?.auto_payout) || 0,
        summary: {
          success: Number(s.success_count) || 0,
          pending: Number(s.pending_count) || 0,
          failed:  Number(s.failed_count)  || 0,
          success_amount: Number(s.success_amount) || 0,
          pending_amount: Number(s.pending_amount) || 0,
        },
        payments,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── POST /api/payments/:id/approve ───────────────────────────────────────────
//   Manual-payment confirmation flow:
//     1. Operator entered the UTR after paying the seller out-of-band
//     2. Mark the payouts row SUCCESS with the supplied UTR
//     3. Tell Binance the order is paid (markOrderAsPaid) so the seller can
//        release the crypto
//     4. Transition the order from AWAITING_MANUAL_PAYMENT → PAYMENT_SENT;
//        the bot's completion poller picks it up from there.
async function approvePayment(req, res) {
  try {
    const { id } = req.params;
    const utr = String(req.body.utr || "").trim();
    if (!utr) {
      return res.status(400).json({ success: false, message: "UTR is required", data: null });
    }

    // 1. Look up the payout + linked order
    const [payoutRows] = await pool.query(
      "SELECT * FROM payouts WHERE id = ? AND status = 'PENDING'",
      [id]
    );
    if (payoutRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payout not found or not in PENDING state",
        data: null,
      });
    }
    const payout = payoutRows[0];
    const orderNo = payout.order_id;

    // 2. Fetch the order's payment method id (payId) — needed by markOrderAsPaid
    const [orderRows] = await pool.query(
      "SELECT state, payment_method FROM orders WHERE order_no = ?",
      [orderNo]
    );
    const order = orderRows[0];

    // 3. Mark paid on Binance with the operator-supplied UTR — fires the
    //    Binance system "marked the order as paid" message in the chat and
    //    passes the UTR via payInfo so it's visible on the seller's UI.
    //    Non-fatal: if Binance rejects, we still record locally and continue.
    let binanceMarked = false;
    let binanceError = null;
    try {
      await markOrderAsPaid(orderNo, null, utr);
      binanceMarked = true;
      logger.info("Manual approve: order marked paid on Binance", {
        orderNo, payoutId: id, utr,
      });
    } catch (err) {
      binanceError = err.response?.data?.msg || err.message;
      logger.error("Manual approve: markOrderAsPaid FAILED — recording locally only", {
        orderNo, error: binanceError,
      });
    }

    // 4. Update payouts row
    await pool.query(
      "UPDATE payouts SET status = 'SUCCESS', utr_number = ? WHERE id = ?",
      [utr, id]
    );

    // 5. Transition the order's state if it's in the awaiting-manual stage.
    //    For any other current state (e.g. bot already moved it on) leave alone.
    if (order && order.state === "AWAITING_MANUAL_PAYMENT") {
      await orderDb.setOrderState(orderNo, "AWAITING_MANUAL_PAYMENT", "PAYMENT_SENT");
      await orderDb.updateOrder(orderNo, { utr_number: utr });

      // Mirror to in-memory state if the bot is currently tracking the order
      const live = stateManager.get(orderNo);
      if (live) {
        stateManager.set(orderNo, ORDER_STATE.PAYMENT_SENT, { utr });
      }
    }

    logger.info("Manual payment approved", { payoutId: id, orderNo, utr, binanceMarked });
    res.json({
      success: true,
      message: binanceMarked
        ? "Payment approved and order marked paid on Binance"
        : `Payment approved (Binance mark-paid failed: ${binanceError})`,
      data: { id, orderNo, utr, binanceMarked, binanceError },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { listPayments, approvePayment };
