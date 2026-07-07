const logger = require('../../utils/logger');
const sellerAdService = require('../services/sellerAdService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const { getSellerIdFromRequest } = require('../utils/sellerUtils');

/**
 * ===== SELLER DASHBOARD CONTROLLER =====
 * API endpoints for dashboard overview and stats
 */
class SellerDashboardController {

  /**
   * GET /api/seller/dashboard
   * Get complete dashboard overview with stats and recent activity
   */
  async getDashboard(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching seller dashboard', { sellerId });

      const { pool } = require('../../config/mysql');

      // 1. Get ads count and status
      const [adsData] = await pool.query(`
        SELECT
          COUNT(*) as totalAds,
          SUM(IF(is_active = true, 1, 0)) as activeAds,
          SUM(IF(is_active = false, 1, 0)) as inactiveAds
        FROM seller_ads
        WHERE seller_id = ?
      `, [sellerId]);

      // 2. Get orders summary
      const [ordersData] = await pool.query(`
        SELECT
          COUNT(*) as totalOrders,
          SUM(IF(current_state = 'COMPLETED', 1, 0)) as completedOrders,
          SUM(IF(current_state = 'REJECTED', 1, 0)) as rejectedOrders,
          SUM(IF(current_state IN ('ELIGIBILITY_CHECK', 'VERIFICATION', 'PAYMENT_WAITING'), 1, 0)) as activeOrders,
          SUM(IF(eligibility_check_passed = true, 1, 0)) as eligibleOrders,
          SUM(IF(eligibility_check_passed = false, 1, 0)) as ineligibleOrders
        FROM seller_orders
        WHERE seller_id = ?
      `, [sellerId]);

      // 3. Get volume stats
      const [volumeData] = await pool.query(`
        SELECT
          SUM(fiat_amount) as totalFiatVolume,
          SUM(crypto_amount) as totalCryptoVolume,
          COUNT(*) as totalTransactions
        FROM seller_orders
        WHERE seller_id = ? AND current_state = 'COMPLETED'
      `, [sellerId]);

      // 4. Get recent orders (last 5)
      const [recentOrders] = await pool.query(`
        SELECT
          order_number, buyer_nickname, ad_no, fiat_amount, crypto_amount, asset,
          current_state, eligibility_check_passed, created_at
        FROM seller_orders
        WHERE seller_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `, [sellerId]);

      // 5. Get ads overview
      const ads = await sellerAdService.getSellerAds(sellerId, true);

      // 6. Get orders by state for pie chart
      const [ordersByState] = await pool.query(`
        SELECT current_state as state, COUNT(*) as count
        FROM seller_orders
        WHERE seller_id = ?
        GROUP BY current_state
      `, [sellerId]);

      // 7. Get verification stats
      const [verificationStats] = await pool.query(`
        SELECT
          SUM(IF(liveness_completed_at IS NOT NULL, 1, 0)) as livenessCompleted,
          SUM(IF(aadhaar_verified_at IS NOT NULL OR pan_verified_at IS NOT NULL, 1, 0)) as documentsVerified,
          SUM(IF(mobile_verified_at IS NOT NULL, 1, 0)) as otpVerified,
          SUM(IF(order_verified_at IS NOT NULL, 1, 0)) as orderVerified,
          SUM(IF(payment_received_at IS NOT NULL, 1, 0)) as paymentReceived
        FROM seller_orders
        WHERE seller_id = ?
      `, [sellerId]);

      // 8. Get top performing ads
      const [topAds] = await pool.query(`
        SELECT
          ad_no,
          COUNT(*) as orderCount,
          SUM(IF(current_state = 'COMPLETED', 1, 0)) as completedCount,
          SUM(fiat_amount) as totalVolume,
          ROUND(SUM(IF(current_state = 'COMPLETED', 1, 0)) * 100 / COUNT(*), 2) as completionRate
        FROM seller_orders
        WHERE seller_id = ?
        GROUP BY ad_no
        ORDER BY orderCount DESC
        LIMIT 5
      `, [sellerId]);

      const dashboard = {
        timestamp: new Date(),
        summary: {
          ads: {
            total: adsData[0]?.totalAds || 0,
            active: adsData[0]?.activeAds || 0,
            inactive: adsData[0]?.inactiveAds || 0
          },
          orders: {
            total: ordersData[0]?.totalOrders || 0,
            completed: ordersData[0]?.completedOrders || 0,
            rejected: ordersData[0]?.rejectedOrders || 0,
            active: ordersData[0]?.activeOrders || 0,
            eligible: ordersData[0]?.eligibleOrders || 0,
            ineligible: ordersData[0]?.ineligibleOrders || 0
          },
          volume: {
            fiat: {
              total: volumeData[0]?.totalFiatVolume || 0,
              currency: 'INR' // From seller's default or config
            },
            crypto: {
              total: volumeData[0]?.totalCryptoVolume || 0,
              asset: 'USDT' // From seller's primary asset
            },
            transactions: volumeData[0]?.totalTransactions || 0
          }
        },
        verification: {
          liveness: {
            completed: verificationStats[0]?.livenessCompleted || 0
          },
          documents: {
            verified: verificationStats[0]?.documentsVerified || 0
          },
          otp: {
            verified: verificationStats[0]?.otpVerified || 0
          },
          orderVerification: {
            completed: verificationStats[0]?.orderVerified || 0
          },
          payment: {
            received: verificationStats[0]?.paymentReceived || 0
          }
        },
        orders: {
          byState: ordersByState.reduce((acc, row) => {
            acc[row.state] = row.count;
            return acc;
          }, {}),
          recent: recentOrders.map(order => ({
            orderNo: order.order_number,
            buyerNickname: order.buyer_nickname,
            adNo: order.ad_no,
            fiatAmount: order.fiat_amount,
            cryptoAmount: order.crypto_amount,
            asset: order.asset,
            state: order.current_state,
            eligible: order.eligibility_check_passed,
            createdAt: order.created_at
          }))
        },
        ads: {
          list: ads.map(ad => ({
            adNo: ad.ad_no,
            asset: ad.asset,
            fiatUnit: ad.fiat_unit,
            price: ad.price_rate || 0,
            isActive: ad.is_active,
            summary: sellerAdService.getRuleSummary(ad.rules)
          })),
          topPerforming: topAds.map(ad => ({
            adNo: ad.ad_no,
            orderCount: ad.orderCount,
            completedCount: ad.completedCount,
            completionRate: ad.completionRate,
            totalVolume: ad.totalVolume
          }))
        },
        health: {
          conversionRate: ordersData[0]?.totalOrders ?
            Math.round((ordersData[0]?.completedOrders / ordersData[0]?.totalOrders) * 100) : 0,
          eligibilityPassRate: ordersData[0]?.totalOrders ?
            Math.round((ordersData[0]?.eligibleOrders / ordersData[0]?.totalOrders) * 100) : 0,
          avgOrderValue: volumeData[0]?.totalTransactions ?
            (volumeData[0]?.totalFiatVolume / volumeData[0]?.totalTransactions).toFixed(2) : 0
        }
      };

      logger.info('✅ Dashboard fetched', { sellerId });

      res.status(200).json({
        success: true,
        data: dashboard
      });

    } catch (error) {
      logger.error(`Dashboard error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/dashboard/health
   * Get seller account health metrics
   */
  async getHealthMetrics(req, res) {
    try {
      const sellerId = req.user.id;

      logger.info('Fetching health metrics', { sellerId });

      const { pool } = require('../../config/mysql');

      const [metrics] = await pool.query(`
        SELECT
          COUNT(*) as totalOrders,
          SUM(IF(current_state = 'COMPLETED', 1, 0)) as completedOrders,
          SUM(IF(current_state = 'REJECTED', 1, 0)) as rejectedOrders,
          SUM(IF(eligibility_check_passed = true, 1, 0)) as eligibleOrders,
          AVG(CASE
            WHEN liveness_completed_at IS NOT NULL THEN
              TIMESTAMPDIFF(MINUTE, liveness_requested_at, liveness_completed_at)
            END) as avgLivenessTime,
          AVG(CASE
            WHEN aadhaar_verified_at IS NOT NULL THEN
              TIMESTAMPDIFF(MINUTE, aadhaar_upload_requested_at, aadhaar_verified_at)
            WHEN pan_verified_at IS NOT NULL THEN
              TIMESTAMPDIFF(MINUTE, pan_upload_requested_at, pan_verified_at)
            END) as avgDocumentVerifyTime,
          MAX(created_at) as lastOrderTime,
          DATE(MAX(created_at)) as lastOrderDate
        FROM seller_orders
        WHERE seller_id = ?
      `, [sellerId]);

      const data = metrics[0];
      const health = {
        totalOrders: data.totalOrders || 0,
        completionRate: data.totalOrders ?
          Math.round((data.completedOrders / data.totalOrders) * 100) : 0,
        rejectionRate: data.totalOrders ?
          Math.round((data.rejectedOrders / data.totalOrders) * 100) : 0,
        eligibilityPassRate: data.totalOrders ?
          Math.round((data.eligibleOrders / data.totalOrders) * 100) : 0,
        avgLivenessTimeMinutes: data.avgLivenessTime ?
          Math.round(data.avgLivenessTime) : 0,
        avgDocumentVerifyTimeMinutes: data.avgDocumentVerifyTime ?
          Math.round(data.avgDocumentVerifyTime) : 0,
        lastOrderTime: data.lastOrderTime,
        lastOrderDate: data.lastOrderDate,
        score: this.calculateHealthScore(data)
      };

      res.status(200).json({
        success: true,
        data: health
      });

    } catch (error) {
      logger.error(`Health metrics error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Helper: Calculate health score (0-100)
   */
  calculateHealthScore(data) {
    if (!data.totalOrders) return 0;

    const completionRate = (data.completedOrders / data.totalOrders) * 100;
    const eligibilityRate = (data.eligibleOrders / data.totalOrders) * 100;
    const rejectionRate = (data.rejectedOrders / data.totalOrders) * 100;

    // Score: 40% completion + 40% eligibility + 20% low rejection
    const score =
      (completionRate * 0.4) +
      (eligibilityRate * 0.4) +
      ((100 - rejectionRate) * 0.2);

    return Math.round(Math.min(score, 100));
  }

  /**
   * GET /api/seller/dashboard/activity
   * Get seller activity log
   */
  async getActivityLog(req, res) {
    try {
      const sellerId = req.user.id;
      const { limit = 20 } = req.query;

      logger.info('Fetching activity log', { sellerId, limit });

      const { pool } = require('../../config/mysql');

      const [activities] = await pool.query(`
        SELECT
          order_number as orderNo,
          from_state as fromState,
          to_state as toState,
          reason,
          created_at as timestamp
        FROM seller_order_state_log
        WHERE order_number IN (
          SELECT order_number FROM seller_orders WHERE seller_id = ?
        )
        ORDER BY created_at DESC
        LIMIT ?
      `, [sellerId, parseInt(limit)]);

      res.status(200).json({
        success: true,
        data: activities,
        count: activities.length
      });

    } catch (error) {
      logger.error(`Activity log error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new SellerDashboardController();
