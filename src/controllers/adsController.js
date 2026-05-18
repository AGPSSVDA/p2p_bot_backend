const { pool } = require("../config/mysql");
const { stateManager } = require("../bot/stateManager");
const orderDb = require("../services/orderDbService");
const { getMyAds } = require("../services/binanceService");

// ── GET /api/ads ─────────────────────────────────────────────────────────────
//   Returns the merchant's ads with order-level aggregations:
//     advNo, tradeType, asset, fiat, price, min/max,
//     totalOrders, completed, cancelled, completionRate,
//     totalVolume (INR), totalCrypto, avgOrderSize, lastOrder, activeNow
//
//   Strategy: pull live ads from Binance (best-effort), upsert into ads table,
//   then LEFT JOIN with the orders table aggregated by adv_no.
async function listAds(req, res) {
  try {
    // 1. Best-effort: fetch live ads from Binance and upsert into the ads table.
    //    If the endpoint is unavailable for this account, getMyAds returns [].
    const liveAds = await getMyAds();
    for (const ad of liveAds) {
      await orderDb.upsertAdFromBinance(ad);
    }

    // 2. Aggregate orders per adv_no
    const [rows] = await pool.query(`
      SELECT
        a.adv_no,
        a.trade_type,
        a.asset,
        a.fiat,
        a.price,
        a.min_amount,
        a.max_amount,
        a.status,
        a.first_seen_at,
        a.last_seen_at,
        a.last_synced_at,
        COUNT(o.id) AS total_orders,
        SUM(CASE WHEN o.state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN o.state IN ('CANCELLED','FAILED','ESCALATED') THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN o.state = 'COMPLETED' THEN o.amount ELSE 0 END) AS total_volume,
        SUM(CASE WHEN o.state = 'COMPLETED' THEN o.crypto_amount ELSE 0 END) AS total_crypto,
        MAX(o.created_at) AS last_order
      FROM ads a
      LEFT JOIN orders o ON o.adv_no = a.adv_no
      GROUP BY a.adv_no
      ORDER BY last_order DESC
    `);

    // 3. activeNow comes from the in-memory state manager (not yet persisted as terminal)
    const liveActive = stateManager.activeOrders();
    const activeByAd = liveActive.reduce((acc, o) => {
      const k = o.advOrderNo || "_";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const ads = rows.map((r) => {
      const totalOrders = Number(r.total_orders) || 0;
      const completed = Number(r.completed) || 0;
      const cancelled = Number(r.cancelled) || 0;
      const totalVolume = Number(r.total_volume) || 0;
      const totalCrypto = Number(r.total_crypto) || 0;
      const completionRate = totalOrders > 0 ? +((completed / totalOrders) * 100).toFixed(2) : 0;
      const avgOrderSize = completed > 0 ? +(totalVolume / completed).toFixed(2) : 0;

      return {
        advNo: r.adv_no,
        tradeType: r.trade_type || "BUY",
        asset: r.asset,
        fiat: r.fiat,
        price: r.price != null ? Number(r.price) : null,
        minAmount: r.min_amount != null ? Number(r.min_amount) : null,
        maxAmount: r.max_amount != null ? Number(r.max_amount) : null,
        status: r.status,
        totalOrders,
        completed,
        cancelled,
        completionRate,
        totalVolume,
        totalCrypto,
        avgOrderSize,
        activeNow: activeByAd[r.adv_no] || 0,
        lastOrder: r.last_order,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        lastSyncedAt: r.last_synced_at,
      };
    });

    // Summary tiles for the Ads page header
    const summary = {
      totalAds: ads.length,
      totalOrders: ads.reduce((s, a) => s + a.totalOrders, 0),
      activeNow: ads.reduce((s, a) => s + a.activeNow, 0),
      avgCompletionRate: ads.length
        ? +((ads.reduce((s, a) => s + a.completionRate, 0) / ads.length).toFixed(2))
        : 0,
    };

    res.json({
      success: true,
      message: "Ads retrieved successfully",
      data: { summary, ads, liveAdsFetched: liveAds.length },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = { listAds };
