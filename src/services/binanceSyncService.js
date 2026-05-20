const { getOrdersByStatus, ORDER_STATUS } = require("./binanceService");
const orderDb = require("./orderDbService");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
//  binanceSyncService — pull historical/terminal orders from Binance and
//  mirror them into our MySQL `orders` table.
//
//  Used by:
//    - POST /api/admin/sync-binance-orders   (on-demand full backfill)
//    - orderPoller periodic sync timer       (light-touch reconciliation)
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = [
  ORDER_STATUS.APPEALING,       // 3
  ORDER_STATUS.COMPLETED,       // 4
  ORDER_STATUS.CANCELLED,       // 6
  ORDER_STATUS.SYS_CANCELLED,   // 7
];

const ALL_STATUSES = [
  ORDER_STATUS.WAIT_PAYMENT,    // 1
  ORDER_STATUS.WAIT_RELEASE,    // 2
  ORDER_STATUS.APPEALING,       // 3
  ORDER_STATUS.COMPLETED,       // 4
  ORDER_STATUS.CANCELLED,       // 6
  ORDER_STATUS.SYS_CANCELLED,   // 7
];

// Iterate one status across pages until an empty page is returned (or maxPages
// is hit) and upsert each row. Idempotent.
async function syncStatus(status, { maxPages = 10, rowsPerPage = 50 } = {}) {
  let synced = 0;
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    let batch;
    try {
      batch = await getOrdersByStatus([status], { page, rows: rowsPerPage });
    } catch (err) {
      logger.warn("binanceSync: page fetch failed", {
        status, page, error: err.message,
      });
      break;
    }
    if (!batch || batch.length === 0) break;
    pages++;
    for (const raw of batch) {
      try {
        await orderDb.upsertOrderFromBinance(raw);
        synced++;
      } catch (err) {
        logger.warn("binanceSync: upsert failed", {
          status,
          orderNo: raw.orderNumber || raw.adOrderNo,
          error: err.message,
        });
      }
    }
    if (batch.length < rowsPerPage) break;   // last page
  }
  return { status, pages, synced };
}

// Sync a list of statuses. Returns per-status counts.
async function sync(statuses, opts = {}) {
  const list = (Array.isArray(statuses) && statuses.length ? statuses : ALL_STATUSES).map(Number);
  const results = [];
  let total = 0;
  for (const s of list) {
    const r = await syncStatus(s, opts);
    results.push(r);
    total += r.synced;
  }
  logger.info("binanceSync complete", {
    total,
    statuses: list,
    perStatus: results,
  });
  return { total, perStatus: results };
}

// Cheap reconciliation pass — only terminal statuses, 1 page each. Safe to
// run every few minutes without blowing rate limits.
async function quickSyncTerminal(opts = {}) {
  return sync(TERMINAL_STATUSES, { maxPages: 1, rowsPerPage: 50, ...opts });
}

module.exports = { sync, syncStatus, quickSyncTerminal, ALL_STATUSES, TERMINAL_STATUSES };
