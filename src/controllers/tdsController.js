const { pool } = require("../config/mysql");
const ExcelJS = require("exceljs");

function buildPeriodFilter(period, from, to) {
  const where = [];
  const params = [];
  switch ((period || "").toUpperCase()) {
    case "MONTH":
      where.push("created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)");
      break;
    case "QUARTER":
      where.push("created_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)");
      break;
    case "YEAR":
      where.push("created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)");
      break;
    case "CUSTOM":
      if (from) { where.push("created_at >= ?"); params.push(from); }
      if (to)   { where.push("created_at <= ?"); params.push(to); }
      break;
    case "ALL":
    default:
      break;
  }
  return { where, params };
}

// ── GET /api/tds ─────────────────────────────────────────────────────────────
async function listTds(req, res) {
  try {
    const { period, from, to, q } = req.query;
    const { where, params } = buildPeriodFilter(period, from, to);

    if (q) {
      where.push("(pan_name LIKE ? OR seller_pan LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `SELECT * FROM payouts ${whereSql} ORDER BY created_at DESC`,
      params
    );

    const records = rows.map((r, idx) => {
      const d = new Date(r.created_at);
      return {
        sr_no:          idx + 1,
        id:             r.id,
        order_id:       r.order_id,
        date:           d.toISOString().slice(0, 10),
        date_display:   `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`,
        name:           r.pan_name || "-",
        pan:            r.seller_pan,
        amount:         Number(r.total_order_amount) || 0,
        tds_deducted:   Number(r.tds_amount) || 0,
        tds_deposited:  Number(r.tds_amount) || 0,
        status:         r.status,
      };
    });

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
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `SELECT * FROM payouts ${whereSql} ORDER BY created_at DESC`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "No data found to export", data: null });
    }

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("TDS Report");

    ws.columns = [
      { header: "SR NO",            key: "sr_no",         width: 10 },
      { header: "DATE",             key: "date",          width: 15 },
      { header: "NAME",             key: "name",          width: 30 },
      { header: "PAN",              key: "pan",           width: 20 },
      { header: "AMOUNT",           key: "amount",        width: 20 },
      { header: "1% TDS DEDUCTED",  key: "tds_deducted",  width: 20 },
      { header: "1% TDS DEPOSITED", key: "tds_deposited", width: 20 },
    ];

    rows.forEach((r, idx) => {
      const d = new Date(r.created_at);
      ws.addRow({
        sr_no:         idx + 1,
        date:          `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`,
        name:          r.pan_name || "-",
        pan:           r.seller_pan,
        amount:        Number(r.total_order_amount).toFixed(2),
        tds_deducted:  Number(r.tds_amount).toFixed(2),
        tds_deposited: Number(r.tds_amount).toFixed(2),
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
