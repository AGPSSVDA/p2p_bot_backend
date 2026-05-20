const { pool } = require("../config/mysql");
const ExcelJS = require("exceljs");
const { config } = require("../config/config");

// TDS percentage from config (default 1%)
const TDS_PCT = Number(config?.bot?.tdsPercent) || 1;

// ── Date column to filter on ────────────────────────────────────────────────
//   completed_at when present (orders finalised), else created_at.
const DATE_COL = "COALESCE(completed_at, created_at)";

function buildPeriodFilter(period, from, to) {
  const where = [`state = 'COMPLETED'`];
  const params = [];
  switch ((period || "").toUpperCase()) {
    case "MONTH":
      where.push(`${DATE_COL} >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`);
      break;
    case "QUARTER":
      where.push(`${DATE_COL} >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)`);
      break;
    case "YEAR":
      where.push(`${DATE_COL} >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`);
      break;
    case "CUSTOM":
      if (from) { where.push(`${DATE_COL} >= ?`); params.push(from); }
      if (to)   { where.push(`${DATE_COL} <= ?`); params.push(to); }
      break;
    case "ALL":
    default:
      break;
  }
  return { where, params };
}

// Normalise a row from the `orders` table into a TDS record. Falls back to
// computed values for synced/historical orders that never went through the
// bot's PAN/TDS flow.
function normaliseRow(r, idx) {
  const dateRaw = r.completed_at || r.created_at;
  const d = new Date(dateRaw);
  const amount = Number(r.pre_tds_amount) || Number(r.amount) || 0;
  // tds_amount may be NULL on historical/synced rows — derive from amount.
  const tds = r.tds_amount != null
    ? Number(r.tds_amount)
    : +(amount * (TDS_PCT / 100)).toFixed(2);

  return {
    sr_no:         idx + 1,
    id:            r.id,
    order_id:      r.order_no,
    date:          d.toISOString().slice(0, 10),
    date_display:  `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`,
    name:          r.pan_name || r.seller_name || r.seller_nickname || "-",
    pan:           r.pan || "-",
    amount,
    tds_deducted:  tds,
    tds_deposited: tds,
    status:        r.state,
  };
}

// ── GET /api/tds ─────────────────────────────────────────────────────────────
async function listTds(req, res) {
  try {
    const { period, from, to, q } = req.query;
    const { where, params } = buildPeriodFilter(period, from, to);

    if (q) {
      where.push("(pan_name LIKE ? OR pan LIKE ? OR seller_name LIKE ? OR seller_nickname LIKE ? OR order_no LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await pool.query(
      `SELECT
         id, order_no, state, amount, pre_tds_amount, tds_amount, post_tds_amount,
         pan, pan_name, seller_name, seller_nickname,
         created_at, completed_at
       FROM orders
       ${whereSql}
       ORDER BY ${DATE_COL} DESC, id DESC`,
      params
    );

    const records = rows.map((r, idx) => normaliseRow(r, idx));

    const summary = records.reduce(
      (acc, r) => {
        acc.records += 1;
        acc.payout_volume += r.amount;
        acc.total_tds += r.tds_deducted;
        return acc;
      },
      { records: 0, payout_volume: 0, total_tds: 0 }
    );

    res.json({
      success: true,
      message: "TDS records retrieved successfully",
      data: { summary, records },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── GET /api/tds/export ──────────────────────────────────────────────────────
async function exportTds(req, res) {
  try {
    const { period, from, to } = req.query;
    const { where, params } = buildPeriodFilter(period, from, to);
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await pool.query(
      `SELECT
         id, order_no, state, amount, pre_tds_amount, tds_amount, post_tds_amount,
         pan, pan_name, seller_name, seller_nickname,
         created_at, completed_at
       FROM orders
       ${whereSql}
       ORDER BY ${DATE_COL} DESC, id DESC`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "No data found to export", data: null });
    }

    const records = rows.map((r, idx) => normaliseRow(r, idx));

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("TDS Report");

    ws.columns = [
      { header: "SR NO",            key: "sr_no",         width: 10 },
      { header: "ORDER NO",         key: "order_id",      width: 22 },
      { header: "DATE",             key: "date_display",  width: 15 },
      { header: "NAME",             key: "name",          width: 30 },
      { header: "PAN",              key: "pan",           width: 20 },
      { header: "AMOUNT",           key: "amount",        width: 20 },
      { header: "1% TDS DEDUCTED",  key: "tds_deducted",  width: 20 },
      { header: "1% TDS DEPOSITED", key: "tds_deposited", width: 20 },
    ];

    records.forEach((r) => {
      ws.addRow({
        sr_no:         r.sr_no,
        order_id:      r.order_id,
        date_display:  r.date_display,
        name:          r.name,
        pan:           r.pan,
        amount:        Number(r.amount).toFixed(2),
        tds_deducted:  Number(r.tds_deducted).toFixed(2),
        tds_deposited: Number(r.tds_deposited).toFixed(2),
      });
    });

    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } };

    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin" }, left: { style: "thin" },
          bottom: { style: "thin" }, right: { style: "thin" },
        };
      });
    });

    const filename = `TDS_Report_${(period || "ALL").toUpperCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { listTds, exportTds };
