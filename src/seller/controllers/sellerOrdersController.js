const logger = require('../../utils/logger');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const { getSellerIdFromRequest } = require('../utils/sellerUtils');

/**
 * ===== SELLER ORDERS CONTROLLER =====
 * API endpoints for order status and management
 */
class SellerOrdersController {

  /**
   * GET /api/seller/orders
   * List all orders for seller with pagination
   */
  async getOrders(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      const { limit = 20, offset = 0, state, adNo } = req.query;

      logger.info('Fetching seller orders', { sellerId, limit, offset, state, adNo });

      let orders;

      if (state) {
        // Filter by state
        orders = await sellerOrderDbService.getOrdersByState(state, parseInt(limit));
      } else if (adNo) {
        // Filter by ad
        orders = await sellerOrderDbService.getOrdersByAdNo(adNo, parseInt(limit), parseInt(offset));
      } else {
        // Get all orders for seller
        const query = `
          SELECT * FROM seller_orders
          WHERE seller_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        const { pool } = require('../../config/mysql');
        const [rows] = await pool.query(query, [sellerId, parseInt(limit), parseInt(offset)]);
        orders = rows;
      }

      // Format response
      const formattedOrders = orders.map(order => ({
        id: order.id,
        orderNo: order.order_number,
        buyerId: order.buyer_id,
        buyerNickname: order.buyer_nickname,
        adNo: order.ad_no,
        cryptoAmount: order.crypto_amount,
        fiatAmount: order.fiat_amount,
        asset: order.asset,
        fiatUnit: order.fiat_unit,
        currentState: order.current_state,
        eligibilityCheckPassed: order.eligibility_check_passed,
        livenessCompleted: order.liveness_completed_at ? true : false,
        documentsVerified: order.pan_verified_at || order.aadhaar_verified_at ? true : false,
        orderVerifiedAt: order.order_verified_at,
        paymentReceivedAt: order.payment_received_at,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        timeline: {
          eligibilityCheckAt: order.eligibility_check_completed_at,
          livenessRequestedAt: order.liveness_requested_at,
          documentsRequestedAt: order.pan_upload_requested_at || order.aadhaar_upload_requested_at,
          orderVerifyAttemptedAt: order.order_verify_attempted_at,
          paymentLinkSentAt: order.payment_link_sent_at
        }
      }));

      res.status(200).json({
        success: true,
        data: formattedOrders,
        count: formattedOrders.length,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });

    } catch (error) {
      logger.error(`Get orders error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/orders/:orderNo
   * Get full order detail with complete state history
   */
  async getOrderDetail(req, res) {
    try {
      const { orderNo } = req.params;
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching order detail', { sellerId, orderNo });

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      // Verify seller owns this order
      if (order.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this order'
        });
      }

      // Get state history
      const { pool } = require('../../config/mysql');
      const [stateHistory] = await pool.query(
        'SELECT * FROM seller_order_state_log WHERE order_number = ? ORDER BY transitioned_at ASC',
        [orderNo]
      );

      // Get verification documents / chat images (oldest first = upload order)
      const [documents] = await pool.query(
        'SELECT * FROM seller_verification_documents WHERE order_number = ? ORDER BY uploaded_at ASC, id ASC',
        [orderNo]
      );

      // Get payment history if available
      const [paymentHistory] = await pool.query(
        'SELECT * FROM seller_payment_history WHERE order_number = ? ORDER BY initiated_at DESC',
        [orderNo]
      );

      // Get order messages
      const [messages] = await pool.query(
        'SELECT * FROM seller_order_messages WHERE order_number = ? ORDER BY sent_at DESC',
        [orderNo]
      );

      const formatted = {
        id: order.id,
        orderNo: order.order_number,
        sellerId: order.seller_id,
        buyerId: order.buyer_id,
        buyerNickname: order.buyer_nickname,
        buyerKycName: order.buyer_kyc_name,
        adNo: order.ad_no,
        crypto: {
          amount: order.crypto_amount,
          asset: order.asset
        },
        fiat: {
          amount: order.fiat_amount,
          unit: order.fiat_unit
        },
        currentState: order.current_state,
        eligibility: {
          checkedAt: order.eligibility_check_completed_at,
          passed: order.eligibility_check_passed,
          failedReason: order.eligibility_check_failed_reason
        },
        liveness: {
          requestedAt: order.liveness_requested_at,
          completedAt: order.liveness_completed_at,
          passed: order.liveness_completed_at ? true : false
        },
        documents: {
          requestedAt: order.pan_upload_requested_at || order.aadhaar_upload_requested_at,
          uploadedAt: order.pan_uploaded_at || order.aadhaar_uploaded_at,
          verifiedAt: order.pan_verified_at || order.aadhaar_verified_at,
          // Images the buyer uploaded in the Binance order chat (Method 2).
          // documentType is null until a later phase classifies Aadhaar vs PAN.
          count: documents.length,
          documents: documents.map(d => ({
            id: d.id,
            type: d.document_type,
            imageUrl: d.image_url,
            thumbnailUrl: d.thumbnail_url,
            imageType: d.image_type,
            width: d.image_width,
            height: d.image_height,
            uploadedAt: d.uploaded_at,
            verifiedAt: d.verified_at,
            status: d.verification_status,
            error: d.verification_error
          }))
        },
        mobileOtp: {
          requestedAt: order.mobile_otp_requested_at,
          verifiedAt: order.mobile_otp_verified_at
        },
        orderVerification: {
          attemptedAt: order.order_verify_attempted_at,
          verifiedAt: order.order_verified_at,
          failedReason: order.order_verify_failed_reason
        },
        payment: {
          linkGeneratedAt: order.payment_link_generated_at,
          sentAt: order.payment_link_sent_at,
          receivedAt: order.payment_received_at,
          gateway: order.payment_gateway,
          deliveryMethod: order.payment_delivery_method,
          history: paymentHistory.map(p => ({
            method: p.payment_method,
            amount: p.amount_inr,
            status: p.status,
            transactionId: p.transaction_id,
            utr: p.utr,
            error: p.error_message,
            initiatedAt: p.initiated_at,
            completedAt: p.completed_at
          }))
        },
        thankYou: {
          sentAt: order.thank_you_message_sent_at
        },
        timeline: {
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          completedAt: order.thank_you_message_sent_at
        },
        stateHistory: stateHistory.map(s => ({
          from: s.from_state,
          to: s.to_state,
          reason: s.reason,
          timestamp: s.transitioned_at
        })),
        messages: messages.map(m => ({
          direction: m.direction,
          sender: m.sender,
          messageType: m.message_type,
          content: m.message_content,
          sentAt: m.sent_at
        }))
      };

      res.status(200).json({
        success: true,
        data: formatted
      });

    } catch (error) {
      logger.error(`Get order detail error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/orders/stats/summary
   * Get order statistics summary
   */
  async getOrderStats(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching order stats', { sellerId });

      const { pool } = require('../../config/mysql');

      // Get stats by state
      const [statsByState] = await pool.query(`
        SELECT current_state as state, COUNT(*) as count
        FROM seller_orders
        WHERE seller_id = ?
        GROUP BY current_state
      `, [sellerId]);

      // Get total stats
      const [totalStats] = await pool.query(`
        SELECT
          COUNT(*) as totalOrders,
          SUM(IF(eligibility_check_passed = true, 1, 0)) as eligibleOrders,
          SUM(IF(eligibility_check_passed = false, 1, 0)) as ineligibleOrders,
          SUM(IF(pan_verified_at IS NOT NULL OR aadhaar_verified_at IS NOT NULL, 1, 0)) as documentsVerifiedOrders,
          SUM(IF(payment_received_at IS NOT NULL, 1, 0)) as completedOrders,
          SUM(fiat_amount) as totalFiatProcessed,
          SUM(crypto_amount) as totalCryptoProcessed
        FROM seller_orders
        WHERE seller_id = ?
      `, [sellerId]);

      // Get stats by ad
      const [statsByAd] = await pool.query(`
        SELECT
          ad_no,
          COUNT(*) as orderCount,
          SUM(IF(eligibility_check_passed = true, 1, 0)) as eligibleCount,
          SUM(IF(payment_received_at IS NOT NULL, 1, 0)) as completedCount
        FROM seller_orders
        WHERE seller_id = ?
        GROUP BY ad_no
      `, [sellerId]);

      const stats = {
        totalOrders: totalStats[0]?.totalOrders || 0,
        byState: statsByState.reduce((acc, row) => {
          acc[row.state] = row.count;
          return acc;
        }, {}),
        eligibleOrders: totalStats[0]?.eligibleOrders || 0,
        ineligibleOrders: totalStats[0]?.ineligibleOrders || 0,
        documentsVerifiedOrders: totalStats[0]?.documentsVerifiedOrders || 0,
        completedOrders: totalStats[0]?.completedOrders || 0,
        totalFiatProcessed: totalStats[0]?.totalFiatProcessed || 0,
        totalCryptoProcessed: totalStats[0]?.totalCryptoProcessed || 0,
        byAd: statsByAd.map(row => ({
          adNo: row.ad_no,
          orderCount: row.orderCount,
          eligibleCount: row.eligibleCount,
          completedCount: row.completedCount
        }))
      };

      res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error(`Get stats error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/orders/timeline/:orderNo
   * Get detailed timeline for order
   */
  async getOrderTimeline(req, res) {
    try {
      const { orderNo } = req.params;
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching order timeline', { sellerId, orderNo });

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      if (order.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this order'
        });
      }

      // Build timeline from order fields
      const timeline = [];

      if (order.created_at) {
        timeline.push({
          step: 1,
          event: 'Order Created',
          timestamp: order.created_at,
          status: 'completed'
        });
      }

      if (order.eligibility_check_completed_at) {
        timeline.push({
          step: 2,
          event: 'Eligibility Check',
          timestamp: order.eligibility_check_completed_at,
          status: order.eligibility_check_passed ? 'passed' : 'failed',
          detail: order.eligibility_check_failed_reason
        });
      }

      if (order.liveness_requested_at) {
        timeline.push({
          step: '3A',
          event: 'Liveness Requested',
          timestamp: order.liveness_requested_at,
          status: order.liveness_completed_at ? 'completed' : 'pending'
        });
      }

      if (order.pan_upload_requested_at || order.aadhaar_upload_requested_at) {
        timeline.push({
          step: '3B',
          event: 'Documents Requested',
          timestamp: order.pan_upload_requested_at || order.aadhaar_upload_requested_at,
          status: order.pan_verified_at || order.aadhaar_verified_at ? 'verified' : 'pending'
        });
      }

      if (order.mobile_otp_requested_at) {
        timeline.push({
          step: '3B-OTP',
          event: 'Mobile OTP Requested',
          timestamp: order.mobile_otp_requested_at,
          status: order.mobile_otp_verified_at ? 'verified' : 'pending'
        });
      }

      if (order.order_verify_attempted_at) {
        timeline.push({
          step: 4,
          event: 'Order Verification',
          timestamp: order.order_verify_attempted_at,
          status: order.order_verified_at ? 'verified' : 'failed',
          detail: order.order_verify_failed_reason
        });
      }

      if (order.payment_link_sent_at) {
        timeline.push({
          step: 5,
          event: 'Payment Link Sent',
          timestamp: order.payment_link_sent_at,
          status: order.payment_received_at ? 'received' : 'pending'
        });
      }

      if (order.payment_received_at) {
        timeline.push({
          step: 5,
          event: 'Payment Received',
          timestamp: order.payment_received_at,
          status: 'completed'
        });
      }

      if (order.thank_you_message_sent_at) {
        timeline.push({
          step: 6,
          event: 'Thank You Message Sent',
          timestamp: order.thank_you_message_sent_at,
          status: 'completed'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          orderNo,
          currentState: order.current_state,
          timeline: timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        }
      });

    } catch (error) {
      logger.error(`Get timeline error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /api/seller/orders/:orderNo/eligibility-check
   * Get detailed eligibility check results for an order
   */
  async getEligibilityCheckDetails(req, res) {
    try {
      const { orderNo } = req.params;
      const sellerId = getSellerIdFromRequest(req);

      logger.info('Fetching eligibility check details', { sellerId, orderNo });

      const order = await sellerOrderDbService.getOrderByNumber(orderNo);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      if (order.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized access to this order'
        });
      }

      // Get ad details for eligibility criteria
      const { pool } = require('../../config/mysql');
      const [adRows] = await pool.query('SELECT * FROM seller_ads WHERE ad_no = ?', [order.ad_no]);
      const ad = adRows[0];

      // Get ad rules
      const [rulesRows] = await pool.query('SELECT * FROM seller_ad_rules WHERE ad_no = ?', [order.ad_no]);
      const rules = rulesRows[0];

      // Get buyer metrics
      const [buyerMetricsRows] = await pool.query('SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?', [order.buyer_id]);
      const buyerMetrics = buyerMetricsRows[0];

      // Build detailed eligibility report
      const criteria = [];

      if (rules && buyerMetrics) {
        // Check all 11 criteria
        const checks = [
          { name: '30-Day Trades', required: rules.min_30day_trades, actual: buyerMetrics.trades_30day },
          { name: 'Completion Rate (%)', required: rules.min_30day_completion_rate, actual: buyerMetrics.completion_rate_30day },
          { name: 'Max Avg Release Time (min)', required: rules.max_avg_release_time > 0 ? rules.max_avg_release_time : 'None', actual: buyerMetrics.avg_release_time_minutes },
          { name: 'Max Avg Pay Time (min)', required: rules.max_avg_pay_time > 0 ? rules.max_avg_pay_time : 'None', actual: buyerMetrics.avg_pay_time_minutes },
          { name: 'Min Registered Days', required: rules.min_registered_days, actual: buyerMetrics.registered_days },
          { name: 'Min Trading Counterparties', required: rules.min_trading_counterparty, actual: buyerMetrics.trading_counterparty_count },
          { name: 'Min All Trades Count', required: rules.min_all_trades_count, actual: buyerMetrics.all_trades_count },
          { name: 'Min Buy Orders Count', required: rules.min_buy_orders_count, actual: buyerMetrics.buy_orders_count },
          { name: 'Min Sell Orders Count', required: rules.min_sell_orders_count, actual: buyerMetrics.sell_orders_count },
          { name: 'Min First Trade Days', required: rules.min_first_trade_days, actual: buyerMetrics.registered_days }
        ];

        checks.forEach(check => {
          let passed;
          if (typeof check.required === 'string' || (typeof check.required === 'number' && check.required === 0)) {
            passed = true;
          } else if (check.name.includes('Max')) {
            // For "Max" criteria (release time, pay time), actual must be <= required
            passed = check.actual <= check.required;
          } else {
            // For "Min" criteria, actual must be >= required
            passed = check.actual >= check.required;
          }

          criteria.push({
            criterion: check.name,
            required: check.required,
            actual: check.actual,
            passed
          });
        });
      }

      res.status(200).json({
        success: true,
        data: {
          orderNo,
          buyer: {
            id: order.buyer_id,
            nickname: order.buyer_nickname,
            kycName: order.buyer_kyc_name
          },
          ad: {
            adNo: order.ad_no,
            asset: ad?.asset,
            fiatUnit: ad?.fiat_unit,
            classify: ad?.classify
          },
          eligibility: {
            checkCompleted: !!order.eligibility_check_completed_at,
            passed: order.eligibility_check_passed === 1,
            failedReason: order.eligibility_check_failed_reason,
            checkedAt: order.eligibility_check_completed_at
          },
          criteria,
          buyerMetrics: buyerMetrics ? {
            trades30Day: buyerMetrics.trades_30day,
            completionRate: buyerMetrics.completion_rate_30day,
            avgReleaseTime: buyerMetrics.avg_release_time_minutes,
            avgPayTime: buyerMetrics.avg_pay_time_minutes,
            registeredDays: buyerMetrics.registered_days,
            tradingCounterparties: buyerMetrics.trading_counterparty_count,
            allTradesCount: buyerMetrics.all_trades_count,
            buyOrdersCount: buyerMetrics.buy_orders_count,
            sellOrdersCount: buyerMetrics.sell_orders_count
          } : null
        }
      });

    } catch (error) {
      logger.error(`Get eligibility check error: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new SellerOrdersController();
