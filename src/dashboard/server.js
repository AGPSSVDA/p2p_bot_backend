const express = require('express');
const path    = require('path');
const { config } = require('../config/config');
const {
  ORDER_STATUS,
  CANCEL_REASON,
  getPendingOrders,
  getOrderDetail,
  cancelOrder,
  canCancelOrder,
  extractPaymentDetails,
} = require('../services/binanceService');
const { stateManager, ORDER_STATE } = require('../bot/stateManager');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Manual cancel-test dashboard
//
//  Lightweight HTML/JSON server for testing order cancellation manually.
//  Default cancel uses reasonCode = 6 (Seller cannot release) which Binance
//  attributes to seller, so buyer's cancellation rate is NOT impacted.
//
//  Endpoints:
//    GET  /                           — dashboard HTML
//    GET  /api/orders                 — active orders (status 1+2)
//    GET  /api/orders/:orderNo        — full detail
//    POST /api/orders/:orderNo/cancel — { reasonCode, additionalInfo }
//    GET  /api/health                 — { ok, time, botActive }
// ─────────────────────────────────────────────────────────────────────────────

function startDashboard(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // ── List active orders + bot state for each ───────────────────────────────
  app.get('/api/orders', async (req, res) => {
    try {
      const orders = await getPendingOrders();
      const enriched = orders.map(o => {
        const orderNo = o.orderNumber || o.adOrderNo || o.orderNo;
        const botSt   = stateManager.get(orderNo);
        return {
          orderNo,
          orderStatus:    o.orderStatus,
          orderStatusText: ({
            1: 'Wait for Payment',
            2: 'Wait for Release',
            3: 'Appealing',
          })[o.orderStatus] || `Status ${o.orderStatus}`,
          asset:          o.asset,
          fiat:           o.fiat,
          fiatSymbol:     o.fiatSymbol,
          amount:         o.amount,
          totalPrice:     o.totalPrice,
          tradeType:      o.tradeType,
          sellerNickname: o.sellerNickname || o.counterPartNickName,
          sellerName:     o.sellerName || null,
          createTime:     o.createTime,
          confirmPayEndTime: o.confirmPayEndTime,
          notifyPayEndTime:  o.notifyPayEndTime,
          chatUnreadCount:   o.chatUnreadCount,
          // Bot's view
          botState:       botSt?.state || null,
          panMasked:      botSt?.pan ? botSt.pan.slice(0, 3) + 'XX' + botSt.pan.slice(5, 9) + 'X' : null,
          panRetries:     botSt?.panRetries || 0,
          isCancellable:  o.orderStatus === 1,   // only status 1 cancellable
        };
      });
      res.json({ success: true, total: enriched.length, orders: enriched });
    } catch (err) {
      logger.error('Dashboard /api/orders failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Full order detail ─────────────────────────────────────────────────────
  app.get('/api/orders/:orderNo', async (req, res) => {
    try {
      const detail = await getOrderDetail(req.params.orderNo);
      let payDetails = null;
      try { payDetails = extractPaymentDetails(detail); } catch (e) {}
      res.json({ success: true, detail, payDetails });
    } catch (err) {
      res.status(500).json({ success: false, error: err.response?.data?.msg || err.message });
    }
  });

  // ── Manual cancel ─────────────────────────────────────────────────────────
  app.post('/api/orders/:orderNo/cancel', async (req, res) => {
    const { orderNo } = req.params;
    const reasonCode = parseInt(req.body.reasonCode, 10) || CANCEL_REASON.SELLER_CANNOT_RELEASE;
    const additionalInfo = String(req.body.additionalInfo || 'Manual cancel via dashboard').slice(0, 200);

    logger.warn('Dashboard manual cancel requested', { orderNo, reasonCode, additionalInfo });

    try {
      // Pre-check
      const allowed = await canCancelOrder(orderNo);
      if (!allowed) {
        return res.status(400).json({
          success: false,
          error:  'Binance says cancel is not allowed for this order (likely already paid or completed)',
        });
      }

      const result = await cancelOrder(orderNo, reasonCode, additionalInfo);

      // Reflect in bot state if we know about this order
      const botOrder = stateManager.get(orderNo);
      if (botOrder) {
        stateManager.set(orderNo, ORDER_STATE.CANCELLED);
      }

      logger.warn('Dashboard manual cancel SUCCESS', { orderNo, reasonCode, additionalInfo, response: result });
      res.json({
        success: true,
        orderNo,
        reasonCode,
        additionalInfo,
        category: reasonCode === 1 || reasonCode === 2
                  ? 'Due to buyer (will increase your cancel rate)'
                  : 'Due to seller (no impact on your rate; may need seller acceptance)',
        binanceResponse: result,
      });
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      logger.error('Dashboard manual cancel FAILED', { orderNo, error: msg });
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({
      ok:        true,
      time:      Date.now(),
      botActive: Object.keys(stateManager.orders).length,
    });
  });

  app.listen(port, () => {
    logger.info(`📊 Dashboard running at http://localhost:${port}`);
  });

  return app;
}

module.exports = { startDashboard };
