const { pool } = require("../config/mysql");
const { stateManager } = require("../bot/stateManager");

const ACTIVE_STATES = [
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
];

const FAILURE_STATES = ["FAILED", "ESCALATED", "CANCELLED"];

// ── GET /api/overview ────────────────────────────────────────────────────────
//   Aggregated KPIs for the dashboard Overview page.
async function getOverview(req, res) {
  try {
    const [totalsRow] = await pool.query(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS orders_today,
        SUM(CASE WHEN YEAR(created_at) = YEAR(CURDATE())
                  AND MONTH(created_at) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS orders_month,
        SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN state IN ('FAILED','ESCALATED','CANCELLED') THEN 1 ELSE 0 END) AS failed_escalated,
        SUM(CASE WHEN state = 'COMPLETED' THEN amount ELSE 0 END) AS volume_inr,
        SUM(CASE WHEN state = 'COMPLETED' THEN crypto_amount ELSE 0 END) AS crypto_bought,
        SUM(CASE WHEN state = 'COMPLETED' AND DATE(created_at) = CURDATE() THEN amount ELSE 0 END) AS volume_today,
        SUM(CASE WHEN state = 'COMPLETED' AND DATE(created_at) = CURDATE() THEN crypto_amount ELSE 0 END) AS crypto_today,
        SUM(CASE WHEN state = 'COMPLETED'
                  AND YEAR(created_at) = YEAR(CURDATE())
                  AND MONTH(created_at) = MONTH(CURDATE()) THEN amount ELSE 0 END) AS volume_month,
        SUM(tds_amount) AS total_tds,
        SUM(CASE WHEN processed_by = 'BOT' THEN 1 ELSE 0 END) AS bot_processed,
        SUM(CASE WHEN processed_by = 'MANUAL' THEN 1 ELSE 0 END) AS manual_processed,
        SUM(CASE WHEN processed_by = 'BOT' AND state = 'COMPLETED' THEN 1 ELSE 0 END) AS bot_completed,
        SUM(CASE WHEN processed_by = 'MANUAL' AND state = 'COMPLETED' THEN 1 ELSE 0 END) AS manual_completed,
        SUM(CASE WHEN processed_by = 'BOT' AND state IN ('FAILED','ESCALATED','CANCELLED') THEN 1 ELSE 0 END) AS bot_failed,
        SUM(CASE WHEN processed_by = 'MANUAL' AND state IN ('FAILED','ESCALATED','CANCELLED') THEN 1 ELSE 0 END) AS manual_failed
      FROM orders
    `);
    const t = totalsRow[0] || {};

    const totalOrders = Number(t.total_orders) || 0;
    const completed = Number(t.completed) || 0;
    const failedEscalated = Number(t.failed_escalated) || 0;
    const successRate = totalOrders > 0 ? +((completed / totalOrders) * 100).toFixed(2) : 0;

    // In-memory active orders gives the freshest active count
    const liveActive = stateManager.activeOrders().length;

    const [statesRows] = await pool.query(`
      SELECT state, COUNT(*) AS cnt FROM orders GROUP BY state
    `);
    const statesBreakdown = statesRows.reduce((acc, r) => {
      acc[r.state] = Number(r.cnt) || 0;
      return acc;
    }, {});

    const [adsRow] = await pool.query("SELECT COUNT(*) AS cnt FROM ads");
    const [payoutsRow] = await pool.query("SELECT COUNT(*) AS cnt, SUM(amount) AS total FROM payouts WHERE status = 'SUCCESS'");

    const [cfgRow] = await pool.query("SELECT bot_status, auto_payout, bot_name FROM bot_config ORDER BY id ASC LIMIT 1");

    res.json({
      success: true,
      message: "Overview KPIs retrieved successfully",
      data: {
        orders_today:      Number(t.orders_today) || 0,
        orders_month:      Number(t.orders_month) || 0,
        total_orders:      totalOrders,
        active_orders:     liveActive,
        completed_orders:  completed,
        failed_escalated:  failedEscalated,
        success_rate:      successRate,
        volume_inr:        Number(t.volume_inr) || 0,
        volume_today:      Number(t.volume_today) || 0,
        volume_month:      Number(t.volume_month) || 0,
        crypto_bought:     Number(t.crypto_bought) || 0,
        crypto_today:      Number(t.crypto_today) || 0,
        total_tds:         Number(t.total_tds) || 0,
        total_payouts:     Number(payoutsRow[0]?.cnt) || 0,
        total_paid_out:    Number(payoutsRow[0]?.total) || 0,
        total_ads:         Number(adsRow[0]?.cnt) || 0,
        bot_processed:     Number(t.bot_processed) || 0,
        manual_processed:  Number(t.manual_processed) || 0,
        bot_completed:     Number(t.bot_completed) || 0,
        manual_completed:  Number(t.manual_completed) || 0,
        bot_failed:        Number(t.bot_failed) || 0,
        manual_failed:     Number(t.manual_failed) || 0,
        states_breakdown:  statesBreakdown,
        active_states:     ACTIVE_STATES,
        failure_states:    FAILURE_STATES,
        bot_status:        Number(cfgRow[0]?.bot_status) || 0,
        auto_payout:       Number(cfgRow[0]?.auto_payout) || 0,
        bot_name:          cfgRow[0]?.bot_name || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── GET /api/overview/daily?days=30 ──────────────────────────────────────────
async function getDailySeries(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const [rows] = await pool.query(`
      SELECT
        DATE(created_at) AS day,
        COUNT(*) AS orders,
        SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN state = 'COMPLETED' THEN amount ELSE 0 END) AS volume,
        SUM(CASE WHEN state = 'COMPLETED' THEN crypto_amount ELSE 0 END) AS crypto
      FROM orders
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `, [days]);

    res.json({
      success: true,
      message: "Daily series retrieved successfully",
      data: rows.map((r) => ({
        day: r.day,
        orders: Number(r.orders) || 0,
        completed: Number(r.completed) || 0,
        volume: Number(r.volume) || 0,
        crypto: Number(r.crypto) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { getOverview, getDailySeries };
