const { pool } = require("../config/mysql");
const logger = require("../utils/logger");

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
//   Marks a PENDING payout as SUCCESS with the supplied UTR. Used when the
//   operator releases payment manually via the Payments page (Phase 1).
async function approvePayment(req, res) {
  try {
    const { id } = req.params;
    const utr = String(req.body.utr || "").trim();
    if (!utr) {
      return res.status(400).json({ success: false, message: "UTR is required", data: null });
    }

    const [result] = await pool.query(
      "UPDATE payouts SET status = 'SUCCESS', utr_number = ? WHERE id = ? AND status = 'PENDING'",
      [utr, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Payout not found or not in PENDING state",
        data: null,
      });
    }

    logger.info("Manual payment approved", { payoutId: id, utr });
    res.json({ success: true, message: "Payment approved", data: { id, utr } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { listPayments, approvePayment };
