const { pool } = require("../config/mysql");
const logger = require("../utils/logger");

// ── GET /api/convert/assets ──────────────────────────────────────────────────
//   Returns the configurable list of target coins used by the auto-convert
//   dropdown on the frontend.
async function listAssets(req, res) {
  try {
    const onlyEnabled = String(req.query.enabled || "").toLowerCase() === "true";
    const whereSql = onlyEnabled ? "WHERE enabled = 1" : "";
    const [rows] = await pool.query(
      `SELECT id, symbol, name, enabled, sort_order, created_at, updated_at
         FROM convert_assets
        ${whereSql}
        ORDER BY sort_order ASC, symbol ASC`
    );
    res.json({
      success: true,
      message: "Convert assets retrieved successfully",
      data: rows.map((r) => ({
        id:         r.id,
        symbol:     r.symbol,
        name:       r.name,
        enabled:    Number(r.enabled) === 1,
        sort_order: r.sort_order,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── POST /api/convert/assets ─────────────────────────────────────────────────
//   Body: { symbol, name?, sort_order? }
//   Adds a new coin to the convert-target dropdown. Symbol is normalised
//   to UPPERCASE and must be unique.
async function addAsset(req, res) {
  try {
    const symbol = String(req.body.symbol || "").trim().toUpperCase();
    const name   = req.body.name ? String(req.body.name).trim() : null;
    const sortOrder = Number.isFinite(Number(req.body.sort_order))
      ? Math.round(Number(req.body.sort_order))
      : null;

    // 1-16 chars — Binance has single-letter tickers (e.g. "U" = United
    // Stables) so a minimum of 1 is correct, not 2.
    if (!symbol || !/^[A-Z0-9]{1,16}$/.test(symbol)) {
      return res.status(400).json({
        success: false,
        message: "symbol is required (1-16 alphanumeric uppercase chars)",
        data: null,
      });
    }

    // Pick a sort_order at the end of the list if none supplied
    let finalSortOrder = sortOrder;
    if (finalSortOrder == null) {
      const [[{ next_order }]] = await pool.query(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM convert_assets"
      );
      finalSortOrder = next_order;
    }

    const [existing] = await pool.query(
      "SELECT id FROM convert_assets WHERE symbol = ? LIMIT 1",
      [symbol]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Asset ${symbol} already exists in the list`,
        data: null,
      });
    }

    // Default enabled=0 (opt-in). Operator explicitly toggles each coin ON
    // from the Convert page to start auto-converting it.
    const initialEnabled = req.body.enabled === true ? 1 : 0;
    const [result] = await pool.query(
      `INSERT INTO convert_assets (symbol, name, enabled, sort_order)
       VALUES (?, ?, ?, ?)`,
      [symbol, name, initialEnabled, finalSortOrder]
    );

    logger.info("Convert asset added", { symbol, name, enabled: initialEnabled, user: req.user?.email });
    res.status(201).json({
      success: true,
      message: `Added ${symbol} to the source-coin list`,
      data: {
        id:         result.insertId,
        symbol,
        name,
        enabled:    initialEnabled === 1,
        sort_order: finalSortOrder,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── PATCH /api/convert/assets/:symbol ────────────────────────────────────────
//   Body: { name?, enabled?, sort_order? }
async function updateAsset(req, res) {
  try {
    const symbol = String(req.params.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, message: "symbol path param required", data: null });
    }
    const fields = [];
    const values = [];
    if (req.body.name !== undefined) {
      fields.push("name = ?");
      values.push(String(req.body.name).trim() || null);
    }
    if (req.body.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(req.body.enabled ? 1 : 0);
    }
    if (req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))) {
      fields.push("sort_order = ?");
      values.push(Math.round(Number(req.body.sort_order)));
    }
    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update", data: null });
    }
    values.push(symbol);
    const [result] = await pool.query(
      `UPDATE convert_assets SET ${fields.join(", ")} WHERE symbol = ?`,
      values
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: `Asset ${symbol} not found`, data: null });
    }
    res.json({ success: true, message: `Updated ${symbol}`, data: { symbol } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── DELETE /api/convert/assets/:symbol ───────────────────────────────────────
//   Removes a source coin from the auto-convert list. Target is hardcoded to
//   USDT system-wide, so there's no "active target" to protect against here.
async function deleteAsset(req, res) {
  try {
    const symbol = String(req.params.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, message: "symbol path param required", data: null });
    }

    const [result] = await pool.query(
      "DELETE FROM convert_assets WHERE symbol = ?",
      [symbol]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: `Asset ${symbol} not found`, data: null });
    }
    logger.info("Convert asset deleted", { symbol, user: req.user?.email });
    res.json({ success: true, message: `Deleted ${symbol}`, data: { symbol } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

// ── GET /api/convert/history ─────────────────────────────────────────────────
//   Paginated history of conversions. Filters: status, q, from, to.
async function listHistory(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (req.query.status) {
      const list = String(req.query.status).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (list.length) {
        where.push(`status IN (${list.map(() => "?").join(",")})`);
        params.push(...list);
      }
    }
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      where.push("(order_no LIKE ? OR from_asset LIKE ? OR to_asset LIKE ?)");
      params.push(q, q, q);
    }
    if (req.query.from) { where.push("created_at >= ?"); params.push(req.query.from); }
    if (req.query.to)   { where.push("created_at <= ?"); params.push(req.query.to); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRow] = await pool.query(
      `SELECT COUNT(*) AS total FROM conversions ${whereSql}`,
      params
    );
    const total = Number(countRow[0]?.total) || 0;

    const [rows] = await pool.query(
      `SELECT * FROM conversions ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const conversions = rows.map((r) => ({
      id:               r.id,
      order_no:         r.order_no,
      from_asset:       r.from_asset,
      to_asset:         r.to_asset,
      from_amount:      Number(r.from_amount) || 0,
      to_amount:        r.to_amount != null ? Number(r.to_amount) : null,
      rate:             r.rate != null ? Number(r.rate) : null,
      binance_quote_id: r.binance_quote_id,
      binance_order_id: r.binance_order_id,
      status:           r.status,
      error_message:    r.error_message,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
    }));

    // Summary tiles
    const [summaryRow] = await pool.query(`
      SELECT
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'FAILED'  THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped_count
      FROM conversions
    `);
    const s = summaryRow[0] || {};

    res.json({
      success: true,
      message: "Conversion history retrieved successfully",
      data: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        summary: {
          success: Number(s.success_count) || 0,
          pending: Number(s.pending_count) || 0,
          failed:  Number(s.failed_count)  || 0,
          skipped: Number(s.skipped_count) || 0,
        },
        conversions,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = {
  listAssets,
  addAsset,
  updateAsset,
  deleteAsset,
  listHistory,
};
