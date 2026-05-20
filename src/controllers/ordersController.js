const { pool } = require("../config/mysql");
const { stateManager } = require("../bot/stateManager");
const logger = require("../utils/logger");
const {
  CANCEL_REASON,
  cancelOrder,
  canCancelOrder,
  getOrderDetail,
  extractPaymentDetails,
} = require("../services/binanceService");

const ORDER_STATUS_TEXT = {
  1: "Wait for Payment",
  2: "Wait for Release",
  3: "Appealing",
  4: "Completed",
  6: "Cancelled by User",
  7: "Cancelled by System",
};

function maskPan(p) {
  if (!p || p.length < 10) return p;
  return `${p.slice(0, 3)}XX${p.slice(5, 9)}X`;
}

// ── GET /api/orders ──────────────────────────────────────────────────────────
//   Query params:
//     page (default 1), limit (default 50, max 200)
//     status — order state (single value or comma-separated list)
//     q      — match against order_no / seller_nickname / pan
//     from   — ISO date (created_at >=)
//     to     — ISO date (created_at <=)
async function listOrders(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (req.query.status) {
      const list = String(req.query.status).split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) {
        where.push(`state IN (${list.map(() => "?").join(",")})`);
        params.push(...list);
      }
    }
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      where.push("(order_no LIKE ? OR seller_nickname LIKE ? OR pan LIKE ? OR pan_name LIKE ?)");
      params.push(q, q, q, q);
    }
    if (req.query.from) {
      where.push("created_at >= ?");
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push("created_at <= ?");
      params.push(req.query.to);
    }
    if (req.query.processed_by) {
      const list = String(req.query.processed_by).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (list.length) {
        where.push(`processed_by IN (${list.map(() => "?").join(",")})`);
        params.push(...list);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRow] = await pool.query(
      `SELECT COUNT(*) AS total FROM orders ${whereSql}`,
      params
    );
    const total = Number(countRow[0]?.total) || 0;

    const [rows] = await pool.query(
      `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const orders = rows.map((r) => ({
      id: `ORD-${String(r.id).padStart(5, "0")}`,
      order_no: r.order_no,
      adv_no: r.adv_no,
      asset: r.asset,
      fiat: r.fiat,
      amount: Number(r.amount) || 0,
      crypto_amount: Number(r.crypto_amount) || 0,
      seller_nickname: r.seller_nickname,
      seller_user_id: r.seller_user_id,
      seller_name: r.seller_name,
      pan: r.pan ? maskPan(r.pan) : null,
      pan_full: r.pan,
      pan_name: r.pan_name,
      pan_retries: r.pan_retries,
      name_match_status: r.name_match_status,
      payment_method: r.payment_method,
      upi_id: r.upi_id,
      account_no: r.account_no,
      ifsc_code: r.ifsc_code,
      bank_name: r.bank_name,
      account_name: r.account_name,
      pre_tds_amount: Number(r.pre_tds_amount) || 0,
      tds_amount: Number(r.tds_amount) || 0,
      post_tds_amount: Number(r.post_tds_amount) || 0,
      payout_id: r.payout_id,
      utr_number: r.utr_number,
      confirm_pay_end_time: r.confirm_pay_end_time,
      notify_pay_end_time: r.notify_pay_end_time,
      state: r.state,
      cancel_reason: r.cancel_reason,
      completed_at: r.completed_at,
      cancelled_at: r.cancelled_at,
      escalated_at: r.escalated_at,
      processed_by: r.processed_by || 'BOT',
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_live: stateManager.has(r.order_no),
    }));

    res.json({
      success: true,
      message: "Orders retrieved successfully",
      data: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        orders,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── GET /api/orders/:orderNo ─────────────────────────────────────────────────
//   Returns DB record + live state-log + most-recent message log.
async function getOrderByNo(req, res) {
  try {
    const { orderNo } = req.params;
    const [rows] = await pool.query("SELECT * FROM orders WHERE order_no = ?", [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found", data: null });
    }
    const r = rows[0];

    const [stateLog] = await pool.query(
      `SELECT from_state, to_state, reason, created_at
       FROM order_state_log WHERE order_no = ? ORDER BY id ASC`,
      [orderNo]
    );

    const [messages] = await pool.query(
      `SELECT direction, sender, template_key, message_text, sent_status, created_at
       FROM order_messages WHERE order_no = ? ORDER BY id ASC LIMIT 500`,
      [orderNo]
    );

    const liveOrder = stateManager.get(orderNo);

    res.json({
      success: true,
      message: "Order retrieved successfully",
      data: {
        order: {
          ...r,
          pan: r.pan ? maskPan(r.pan) : null,
          pan_full: r.pan,
        },
        state_log: stateLog,
        messages,
        live: liveOrder ? {
          state: liveOrder.state,
          reminderSent: liveOrder.reminderSent,
          lastWarningSent: liveOrder.lastWarningSent,
          panRetries: liveOrder.panRetries,
        } : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── POST /api/orders/:orderNo/cancel ─────────────────────────────────────────
async function cancelOrderManual(req, res) {
  const { orderNo } = req.params;
  const reasonCode = parseInt(req.body.reasonCode, 10) || CANCEL_REASON.SELLER_CANNOT_RELEASE;
  const additionalInfo = String(req.body.additionalInfo || "Manual cancel via dashboard").slice(0, 200);

  logger.warn("Manual cancel requested via API", { orderNo, reasonCode, additionalInfo });
  try {
    const allowed = await canCancelOrder(orderNo);
    if (!allowed) {
      return res.status(400).json({
        success: false,
        message: "Binance says cancel is not allowed for this order (likely already paid or completed)",
        data: null,
      });
    }

    const result = await cancelOrder(orderNo, reasonCode, additionalInfo);

    await pool.query(
      "UPDATE orders SET state = 'CANCELLED', cancel_reason = ?, cancelled_at = NOW() WHERE order_no = ?",
      [additionalInfo, orderNo]
    );

    res.json({
      success: true,
      message: "Order cancellation submitted to Binance",
      data: {
        orderNo,
        reasonCode,
        additionalInfo,
        category:
          reasonCode === 1 || reasonCode === 2
            ? "Due to buyer (will increase your cancel rate)"
            : "Due to seller (no impact on your rate; may need seller acceptance)",
        binanceResponse: result,
      },
    });
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error("Manual cancel FAILED", { orderNo, error: msg });
    res.status(500).json({ success: false, message: msg, data: null });
  }
}

// ── GET /api/orders/:orderNo/live ────────────────────────────────────────────
//   Live order detail straight from Binance (matches old dashboard endpoint).
async function getLiveDetail(req, res) {
  try {
    const detail = await getOrderDetail(req.params.orderNo);
    let payDetails = null;
    try { payDetails = extractPaymentDetails(detail); } catch (e) {}
    res.json({
      success: true,
      message: "Live order detail retrieved",
      data: { detail, payDetails },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.response?.data?.msg || err.message,
      data: null,
    });
  }
}

// ── GET /api/orders/states ───────────────────────────────────────────────────
function getStateEnum(req, res) {
  res.json({
    success: true,
    message: "Order state enum",
    data: {
      states: [
        "NEW_ORDER",
        "WAITING_FOR_PAN",
        "VALIDATING_PAN",
        "PAN_VERIFIED",
        "WAITING_TDS_CONSENT",
        "TDS_ACCEPTED",
        "PROCESSING_PAYMENT",
        "AWAITING_MANUAL_PAYMENT",
        "PAYMENT_SENT",
        "WAITING_FOR_RELEASE",
        "COMPLETED",
        "ESCALATED",
        "FAILED",
        "CANCELLED",
      ],
      status_text_map: ORDER_STATUS_TEXT,
    },
  });
}

module.exports = {
  listOrders,
  getOrderByNo,
  cancelOrderManual,
  getLiveDetail,
  getStateEnum,
};
