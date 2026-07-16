const { pool } = require('../../config/mysql');
const logger = require('../../utils/logger');

// Wrapper for safe DB operations (non-throwing)
function safe(promise, label) {
  return Promise.resolve(promise).catch((err) => {
    logger.warn(`Seller DB write failed: ${label}`, { error: err.message });
    return null;
  });
}

class SellerOrderDbService {

  // ===== CRUD: SELLER ORDERS =====

  /**
   * Create or update seller order
   */
  async upsertOrder(orderData) {
    const query = `
      INSERT INTO seller_orders (
        order_number, seller_id, buyer_id, buyer_nickname, ad_no,
        crypto_amount, fiat_amount, asset, fiat_unit, buyer_kyc_name,
        current_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        buyer_nickname = VALUES(buyer_nickname),
        buyer_kyc_name = VALUES(buyer_kyc_name),
        updated_at = NOW()
    `;

    // Guard NOT NULL columns so a missing field can never silently drop the row.
    const buyerId = orderData.buyerId || `unknown-${orderData.orderNumber}`;
    const buyerNickname = orderData.buyerNickname || 'Unknown';

    // NOTE: do NOT wrap this in safe(). Persisting the order is load-bearing —
    // every downstream step (liveness, verify, payment) reads it back from the DB.
    // If it fails we must know, not swallow it.
    try {
      await pool.query(query, [
        orderData.orderNumber,
        orderData.sellerId,
        buyerId,
        buyerNickname,
        orderData.adNo,
        orderData.cryptoAmount,
        orderData.fiatAmount,
        orderData.asset,
        orderData.fiatUnit,
        orderData.buyerKycName,
        'NEW_ORDER'
      ]);
      return true;
    } catch (err) {
      logger.error(`❌ CRITICAL: upsertOrder failed for ${orderData.orderNumber} - order NOT persisted`, {
        code: err.code,
        sqlMessage: err.sqlMessage,
      });
      throw err;
    }
  }

  /**
   * Get order by order number
   */
  async getOrderByNumber(orderNumber) {
    const query = 'SELECT * FROM seller_orders WHERE order_number = ?';
    const [rows] = await pool.query(query, [orderNumber]);
    return rows[0] || null;
  }

  /**
   * Get all orders for an ad
   */
  async getOrdersByAdNo(adNo, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM seller_orders
      WHERE ad_no = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(query, [adNo, limit, offset]);
    return rows;
  }

  /**
   * Get orders by state
   */
  async getOrdersByState(state, limit = 50) {
    const query = `
      SELECT * FROM seller_orders
      WHERE current_state = ?
      ORDER BY created_at ASC
      LIMIT ?
    `;
    const [rows] = await pool.query(query, [state, limit]);
    return rows;
  }

  // ===== STATE TRANSITIONS =====

  /**
   * Set order state
   */
  async setOrderState(orderNumber, newState, reason = null) {
    try {
      // Get current order
      const order = await this.getOrderByNumber(orderNumber);
      if (!order) return;

      const fromState = order.current_state;

      // Update orders table
      const updateQuery = `
        UPDATE seller_orders
        SET current_state = ?, updated_at = NOW()
        WHERE order_number = ?
      `;
      await pool.query(updateQuery, [newState, orderNumber]);

      // Log state transition
      const logQuery = `
        INSERT INTO seller_order_state_log (order_number, from_state, to_state, reason)
        VALUES (?, ?, ?, ?)
      `;
      await pool.query(logQuery, [orderNumber, fromState, newState, reason]);

      logger.info(`[${orderNumber}] State: ${fromState} → ${newState}`, { reason });

    } catch (error) {
      logger.error(`State update failed: ${error.message}`, { orderNumber });
    }
  }

  // ===== STEP 2: ELIGIBILITY CHECK =====

  async recordEligibilityCheck(orderNumber, passed, failedReason = null) {
    const query = `
      UPDATE seller_orders
      SET
        eligibility_check_completed_at = NOW(),
        eligibility_check_passed = ?,
        eligibility_check_failed_reason = ?
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [passed, failedReason, orderNumber]),
      `recordEligibilityCheck:${orderNumber}`
    );
  }

  // ===== STEP 3A: LIVENESS VERIFICATION =====

  async recordLivenessRequested(orderNumber) {
    const query = `
      UPDATE seller_orders
      SET liveness_requested_at = NOW()
      WHERE order_number = ?
    `;
    return safe(pool.query(query, [orderNumber]), `recordLivenessRequested:${orderNumber}`);
  }

  async recordLivenessCompleted(orderNumber, passed) {
    const query = `
      UPDATE seller_orders
      SET
        liveness_completed_at = NOW(),
        liveness_passed = ?
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [passed, orderNumber]),
      `recordLivenessCompleted:${orderNumber}`
    );
  }

  // ===== METHOD 2 / PHASE 1: DOCUMENT IMAGES FROM BINANCE CHAT =====

  /**
   * Save one image the buyer uploaded in the Binance order chat.
   *
   * Idempotent: a unique index on (order_number, chat_message_id) means
   * re-polling the chat will not insert the same image twice.
   * Phase 1 stores the Binance image URL + metadata only — no download,
   * and document_type stays NULL (classification is a later phase).
   *
   * Returns true if a new image row was inserted, false if it already existed.
   */
  async saveChatImage(orderNumber, buyerId, image) {
    // INSERT IGNORE + the unique index on (order_number, chat_message_id) makes
    // this idempotent: re-polling the chat silently skips images already stored.
    // We use IGNORE (not ON DUPLICATE KEY UPDATE) because MariaDB reports
    // affectedRows=0 for a no-op update, which makes "was it new?" ambiguous.
    const query = `
      INSERT IGNORE INTO seller_verification_documents (
        order_number, buyer_id, image_url, thumbnail_url, image_type,
        image_width, image_height, chat_message_id, chat_message_uuid,
        uploaded_at, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const uploadedAt = image.createTime ? new Date(image.createTime) : new Date();

    const [result] = await pool.query(query, [
      orderNumber,
      buyerId || `unknown-${orderNumber}`,
      image.imageUrl,
      image.thumbnailUrl || null,
      image.imageType || null,
      image.width || null,
      image.height || null,
      String(image.id),
      image.uuid || null,
      uploadedAt,
      'UPLOADED',
    ]);

    // INSERT IGNORE: affectedRows === 1 => newly inserted, 0 => already existed
    return result.affectedRows === 1;
  }

  /**
   * Get all chat images stored for an order (oldest first).
   */
  async getChatImages(orderNumber) {
    const query = `
      SELECT id, order_number, buyer_id, document_type, image_url, thumbnail_url,
             image_type, image_width, image_height, chat_message_id, uploaded_at,
             verification_status
      FROM seller_verification_documents
      WHERE order_number = ? AND image_url IS NOT NULL
      ORDER BY uploaded_at ASC, id ASC
    `;
    const [rows] = await pool.query(query, [orderNumber]);
    return rows;
  }

  // ===== STEP 3B: DOCUMENT VERIFICATION =====

  async recordDocumentUploadRequested(orderNumber, docType) {
    const timeField = docType === 'aadhaar'
      ? 'aadhaar_upload_requested_at'
      : docType === 'pan'
      ? 'pan_upload_requested_at'
      : 'mobile_requested_at';

    const query = `
      UPDATE seller_orders
      SET ${timeField} = NOW()
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [orderNumber]),
      `recordDocumentUploadRequested:${orderNumber}:${docType}`
    );
  }

  async recordDocumentUploaded(orderNumber, docType) {
    const timeField = docType === 'aadhaar'
      ? 'aadhaar_uploaded_at'
      : docType === 'pan'
      ? 'pan_uploaded_at'
      : 'mobile_uploaded_at';

    const query = `
      UPDATE seller_orders
      SET ${timeField} = NOW()
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [orderNumber]),
      `recordDocumentUploaded:${orderNumber}:${docType}`
    );
  }

  async recordDocumentVerified(orderNumber, docType, passed, failureReason = null) {
    let query;

    if (docType === 'aadhaar') {
      query = `
        UPDATE seller_orders
        SET
          aadhaar_verified_at = NOW(),
          aadhaar_verification_passed = ?
        WHERE order_number = ?
      `;
    } else if (docType === 'pan') {
      query = `
        UPDATE seller_orders
        SET
          pan_verified_at = NOW(),
          pan_verification_passed = ?
        WHERE order_number = ?
      `;
    } else if (docType === 'mobile') {
      query = `
        UPDATE seller_orders
        SET
          mobile_verified_at = NOW(),
          mobile_verification_passed = ?
        WHERE order_number = ?
      `;
    }

    return safe(
      pool.query(query, [passed, orderNumber]),
      `recordDocumentVerified:${orderNumber}:${docType}`
    );
  }

  // ===== STEP 4: ORDER VERIFICATION =====

  async recordOrderVerifyAttempted(orderNumber) {
    const query = `
      UPDATE seller_orders
      SET order_verify_attempted_at = NOW()
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [orderNumber]),
      `recordOrderVerifyAttempted:${orderNumber}`
    );
  }

  async recordOrderVerified(orderNumber, success, failureReason = null) {
    const query = `
      UPDATE seller_orders
      SET
        order_verified_at = ${success ? 'NOW()' : 'NULL'},
        order_verify_failed_reason = ?
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [failureReason, orderNumber]),
      `recordOrderVerified:${orderNumber}`
    );
  }

  // ===== STEP 5: PAYMENT TRACKING (Method 3 only) =====

  async recordPaymentLinkGenerated(orderNumber, gateway, deliveryMethod) {
    const query = `
      UPDATE seller_orders
      SET
        payment_link_generated_at = NOW(),
        payment_gateway = ?,
        payment_link_expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR)
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [gateway, orderNumber]),
      `recordPaymentLinkGenerated:${orderNumber}`
    );
  }

  async recordPaymentLinkSent(orderNumber) {
    const query = `
      UPDATE seller_orders
      SET payment_link_sent_at = NOW()
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [orderNumber]),
      `recordPaymentLinkSent:${orderNumber}`
    );
  }

  async recordPaymentReceived(orderNumber, utr, amount) {
    const query = `
      UPDATE seller_orders
      SET
        payment_received_at = NOW(),
        payment_utr = ?,
        payment_amount = ?
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [utr, amount, orderNumber]),
      `recordPaymentReceived:${orderNumber}`
    );
  }

  // ===== STEP 6: THANK YOU MESSAGE =====

  async recordThankYouMessageSent(orderNumber) {
    const query = `
      UPDATE seller_orders
      SET thank_you_message_sent_at = NOW()
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [orderNumber]),
      `recordThankYouMessageSent:${orderNumber}`
    );
  }

  // ===== ERROR TRACKING =====

  async recordError(orderNumber, errorMessage) {
    const query = `
      UPDATE seller_orders
      SET last_error_message = ?
      WHERE order_number = ?
    `;
    return safe(
      pool.query(query, [errorMessage, orderNumber]),
      `recordError:${orderNumber}`
    );
  }

  // ===== ORDER MESSAGES =====

  async addOrderMessage(orderNumber, direction, content, messageType = 'TEXT', binanceMsgId = null) {
    const query = `
      INSERT INTO seller_order_messages
      (order_number, direction, sender, message_type, message_content, binance_msg_id)
      VALUES (?, ?, 'bot', ?, ?, ?)
    `;
    return safe(
      pool.query(query, [orderNumber, direction, messageType, content, binanceMsgId]),
      `addOrderMessage:${orderNumber}`
    );
  }

  // ===== AD MANAGEMENT =====

  async upsertAd(sellerId, adNo, adData) {
    const query = `
      INSERT INTO seller_ads (
        seller_id, ad_no, ad_name, ad_status, is_active,
        classify, trade_type, asset, fiat_unit, fiat_symbol,
        price_rate, price_type, price_floating_ratio, commission_rate,
        min_order_amount, max_order_amount, surplus_amount, init_amount,
        buyer_kyc_required, buyer_reg_days_limit, buyer_btc_position_limit,
        user_buy_trade_count_min, user_buy_trade_count_max,
        user_sell_trade_count_min, user_sell_trade_count_max,
        user_all_trade_count_min, user_all_trade_count_max,
        user_trade_complete_count_min, user_trade_complete_rate_min,
        user_trade_volume_min, user_trade_volume_max,
        pay_time_limit, remarks, auto_reply_msg, offline_reason,
        asset_scale, fiat_scale, price_scale,
        binance_create_time, binance_update_time,
        total_orders, completed_orders, failed_orders
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        -- Refresh EVERY Binance-sourced column so a re-sync reflects the latest
        -- ad state (remarks, limits, pay time, etc.), not just price/status.
        -- Deliberately NOT updated: is_active, total_orders, completed_orders,
        -- failed_orders, binance_create_time — these are local/bot-owned and a
        -- re-sync must not reset them.
        ad_name = VALUES(ad_name),
        ad_status = VALUES(ad_status),
        classify = VALUES(classify),
        trade_type = VALUES(trade_type),
        asset = VALUES(asset),
        fiat_unit = VALUES(fiat_unit),
        fiat_symbol = VALUES(fiat_symbol),
        price_rate = VALUES(price_rate),
        price_type = VALUES(price_type),
        price_floating_ratio = VALUES(price_floating_ratio),
        commission_rate = VALUES(commission_rate),
        min_order_amount = VALUES(min_order_amount),
        max_order_amount = VALUES(max_order_amount),
        surplus_amount = VALUES(surplus_amount),
        init_amount = VALUES(init_amount),
        buyer_kyc_required = VALUES(buyer_kyc_required),
        buyer_reg_days_limit = VALUES(buyer_reg_days_limit),
        buyer_btc_position_limit = VALUES(buyer_btc_position_limit),
        user_buy_trade_count_min = VALUES(user_buy_trade_count_min),
        user_buy_trade_count_max = VALUES(user_buy_trade_count_max),
        user_sell_trade_count_min = VALUES(user_sell_trade_count_min),
        user_sell_trade_count_max = VALUES(user_sell_trade_count_max),
        user_all_trade_count_min = VALUES(user_all_trade_count_min),
        user_all_trade_count_max = VALUES(user_all_trade_count_max),
        user_trade_complete_count_min = VALUES(user_trade_complete_count_min),
        user_trade_complete_rate_min = VALUES(user_trade_complete_rate_min),
        user_trade_volume_min = VALUES(user_trade_volume_min),
        user_trade_volume_max = VALUES(user_trade_volume_max),
        pay_time_limit = VALUES(pay_time_limit),
        remarks = VALUES(remarks),
        auto_reply_msg = VALUES(auto_reply_msg),
        offline_reason = VALUES(offline_reason),
        asset_scale = VALUES(asset_scale),
        fiat_scale = VALUES(fiat_scale),
        price_scale = VALUES(price_scale),
        binance_update_time = VALUES(binance_update_time),
        updated_at = NOW()
    `;

    return safe(
      pool.query(query, [
        sellerId, adNo, adData.advNo, adData.advStatus, true,
        adData.classify, adData.tradeType, adData.asset, adData.fiatUnit, adData.fiatSymbol,
        adData.price, adData.priceType, adData.priceFloatingRatio, adData.commissionRate,
        adData.minSingleTransAmount, adData.maxSingleTransAmount, adData.surplusAmount, adData.initAmount,
        adData.buyerKycLimit === 1, adData.buyerRegDaysLimit, adData.buyerBtcPositionLimit,
        adData.userBuyTradeCountMin, adData.userBuyTradeCountMax,
        adData.userSellTradeCountMin, adData.userSellTradeCountMax,
        adData.userAllTradeCountMin, adData.userAllTradeCountMax,
        adData.userTradeCompleteCountMin, adData.userTradeCompleteRateMin,
        adData.userTradeVolumeMin, adData.userTradeVolumeMax,
        adData.payTimeLimit, adData.remarks, adData.autoReplyMsg, adData.offlineReason,
        adData.assetScale, adData.fiatScale, adData.priceScale,
        adData.createTime, adData.advUpdateTime,
        0, 0, 0  // total_orders, completed_orders, failed_orders (initialize to 0)
      ]),
      `upsertAd:${adNo}`
    );
  }

  async getAdsBySellerAndStatus(sellerId, isActive = true) {
    const query = `
      SELECT * FROM seller_ads
      WHERE seller_id = ? AND is_active = ?
      ORDER BY created_at DESC
    `;
    const [rows] = await pool.query(query, [sellerId, isActive]);
    return rows;
  }

  async getAdByNo(adNo) {
    const query = 'SELECT * FROM seller_ads WHERE ad_no = ?';
    const [rows] = await pool.query(query, [adNo]);
    return rows[0] || null;
  }

  // ===== AD RULES =====

  /**
   * Update ONLY the verification-method columns for an ad.
   *
   * Deliberately separate from upsertAdRules(), which writes every column —
   * using that for a methods-only save would clobber the eligibility criteria.
   * Methods are bot-side behaviour and never sync to Binance.
   */
  async updateAdMethods(sellerId, adNo, methods) {
    // INSERT ... ON DUPLICATE KEY UPDATE on (seller_id, ad_no):
    //  - creates the rules row (methods set, all other columns default) if the ad
    //    has no rules yet — a plain UPDATE would match 0 rows and "fail" here.
    //  - if the row exists, updates ONLY the method columns, leaving the
    //    eligibility criteria untouched.
    const query = `
      INSERT INTO seller_ad_rules (
        seller_id, ad_no,
        method1_liveness_enabled, method2_documents_enabled,
        method2_mobile_verification_enabled, method3_full_enabled,
        method3_mobile_verification_enabled, method3_payment_link_enabled,
        method3_payment_gateway, method3_delivery_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        method1_liveness_enabled = VALUES(method1_liveness_enabled),
        method2_documents_enabled = VALUES(method2_documents_enabled),
        method2_mobile_verification_enabled = VALUES(method2_mobile_verification_enabled),
        method3_full_enabled = VALUES(method3_full_enabled),
        method3_mobile_verification_enabled = VALUES(method3_mobile_verification_enabled),
        method3_payment_link_enabled = VALUES(method3_payment_link_enabled),
        method3_payment_gateway = VALUES(method3_payment_gateway),
        method3_delivery_method = VALUES(method3_delivery_method),
        updated_at = NOW()
    `;

    const [result] = await pool.query(query, [
      sellerId,
      adNo,
      methods.method1_liveness_enabled ? 1 : 0,
      methods.method2_documents_enabled ? 1 : 0,
      methods.method2_mobile_verification_enabled ? 1 : 0,
      methods.method3_full_enabled ? 1 : 0,
      methods.method3_mobile_verification_enabled ? 1 : 0,
      methods.method3_payment_link_enabled ? 1 : 0,
      methods.method3_payment_gateway || 'razorpay',
      methods.method3_delivery_method || 'payment_link',
    ]);

    // insert -> affectedRows 1; update with changes -> 1 or 2. updated_at=NOW()
    // guarantees a row change even when method flags are unchanged, so a real
    // save always reports >= 1. (0 would only happen if the query hit no row,
    // which the upsert prevents.)
    return result.affectedRows >= 1;
  }

  async upsertAdRules(sellerId, adNo, rulesData) {
    const query = `
      INSERT INTO seller_ad_rules (
        seller_id, ad_no,
        min_30day_trades_enabled, min_30day_trades,
        min_30day_completion_rate_enabled, min_30day_completion_rate,
        max_avg_release_time_enabled, max_avg_release_time,
        max_avg_pay_time_enabled, max_avg_pay_time,
        required_trade_type_enabled, required_trade_type,
        min_registered_days_enabled, min_registered_days,
        min_first_trade_days_enabled, min_first_trade_days,
        min_trading_counterparty_enabled, min_trading_counterparty,
        min_all_trades_count_enabled, min_all_trades_count,
        min_buy_orders_count_enabled, min_buy_orders_count,
        min_sell_orders_count_enabled, min_sell_orders_count,
        method1_liveness_enabled, method2_documents_enabled,
        method2_mobile_verification_enabled, method3_full_enabled,
        method3_mobile_verification_enabled, method3_payment_link_enabled,
        method3_payment_gateway, method3_delivery_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        min_30day_trades_enabled = VALUES(min_30day_trades_enabled),
        min_30day_trades = VALUES(min_30day_trades),
        min_30day_completion_rate_enabled = VALUES(min_30day_completion_rate_enabled),
        min_30day_completion_rate = VALUES(min_30day_completion_rate),
        max_avg_release_time_enabled = VALUES(max_avg_release_time_enabled),
        max_avg_release_time = VALUES(max_avg_release_time),
        max_avg_pay_time_enabled = VALUES(max_avg_pay_time_enabled),
        max_avg_pay_time = VALUES(max_avg_pay_time),
        required_trade_type_enabled = VALUES(required_trade_type_enabled),
        required_trade_type = VALUES(required_trade_type),
        min_registered_days_enabled = VALUES(min_registered_days_enabled),
        min_registered_days = VALUES(min_registered_days),
        min_first_trade_days_enabled = VALUES(min_first_trade_days_enabled),
        min_first_trade_days = VALUES(min_first_trade_days),
        min_trading_counterparty_enabled = VALUES(min_trading_counterparty_enabled),
        min_trading_counterparty = VALUES(min_trading_counterparty),
        min_all_trades_count_enabled = VALUES(min_all_trades_count_enabled),
        min_all_trades_count = VALUES(min_all_trades_count),
        min_buy_orders_count_enabled = VALUES(min_buy_orders_count_enabled),
        min_buy_orders_count = VALUES(min_buy_orders_count),
        min_sell_orders_count_enabled = VALUES(min_sell_orders_count_enabled),
        min_sell_orders_count = VALUES(min_sell_orders_count),
        method1_liveness_enabled = VALUES(method1_liveness_enabled),
        method2_documents_enabled = VALUES(method2_documents_enabled),
        method2_mobile_verification_enabled = VALUES(method2_mobile_verification_enabled),
        method3_full_enabled = VALUES(method3_full_enabled),
        method3_mobile_verification_enabled = VALUES(method3_mobile_verification_enabled),
        method3_payment_link_enabled = VALUES(method3_payment_link_enabled),
        method3_payment_gateway = VALUES(method3_payment_gateway),
        method3_delivery_method = VALUES(method3_delivery_method),
        updated_at = NOW()
    `;

    return safe(
      pool.query(query, [
        sellerId, adNo,
        rulesData.min_30day_trades_enabled ?? true, rulesData.min_30day_trades,
        rulesData.min_30day_completion_rate_enabled ?? true, rulesData.min_30day_completion_rate,
        rulesData.max_avg_release_time_enabled ?? true, rulesData.max_avg_release_time,
        rulesData.max_avg_pay_time_enabled ?? true, rulesData.max_avg_pay_time,
        rulesData.required_trade_type_enabled ?? true, rulesData.required_trade_type,
        rulesData.min_registered_days_enabled ?? true, rulesData.min_registered_days,
        rulesData.min_first_trade_days_enabled ?? true, rulesData.min_first_trade_days,
        rulesData.min_trading_counterparty_enabled ?? true, rulesData.min_trading_counterparty,
        rulesData.min_all_trades_count_enabled ?? true, rulesData.min_all_trades_count,
        rulesData.min_buy_orders_count_enabled ?? true, rulesData.min_buy_orders_count,
        rulesData.min_sell_orders_count_enabled ?? true, rulesData.min_sell_orders_count,
        rulesData.method1_liveness_enabled,
        rulesData.method2_documents_enabled,
        rulesData.method2_mobile_verification_enabled,
        rulesData.method3_full_enabled,
        rulesData.method3_mobile_verification_enabled,
        rulesData.method3_payment_link_enabled,
        rulesData.method3_payment_gateway,
        rulesData.method3_delivery_method
      ]),
      `upsertAdRules:${adNo}`
    );
  }

  async getAdRules(adNo) {
    const query = 'SELECT * FROM seller_ad_rules WHERE ad_no = ?';
    const [rows] = await pool.query(query, [adNo]);
    return rows[0] || null;
  }

  async upsertAdTradeMethod(sellerId, adNo, method) {
    const query = `
      INSERT INTO seller_ad_trade_methods (
        ad_no, seller_id, pay_id, pay_type, identifier,
        trade_method_name, icon_url, icon_url_color, commission_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        pay_type = VALUES(pay_type),
        trade_method_name = VALUES(trade_method_name),
        icon_url = VALUES(icon_url),
        icon_url_color = VALUES(icon_url_color),
        commission_rate = VALUES(commission_rate),
        updated_at = NOW()
    `;

    return safe(
      pool.query(query, [
        adNo, sellerId, method.payId, method.payType, method.identifier,
        method.tradeMethodName, method.iconUrl, method.iconUrlColor, method.commissionRate
      ]),
      `upsertAdTradeMethod:${adNo}:${method.payId}`
    );
  }

  async getAdTradeMethods(adNo) {
    const query = 'SELECT * FROM seller_ad_trade_methods WHERE ad_no = ? ORDER BY id ASC';
    const [rows] = await pool.query(query, [adNo]);
    return rows || [];
  }

  // ===== BUYER METRICS =====

  async upsertBuyerMetrics(buyerId, metricsData) {
    const query = `
      INSERT INTO seller_buyer_metrics (
        buyer_id, trades_30day, completion_rate_30day,
        avg_release_time_minutes, avg_pay_time_minutes,
        registered_days, first_trade_date, trading_counterparty_count,
        all_trades_count, buy_orders_count, sell_orders_count, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        trades_30day = VALUES(trades_30day),
        completion_rate_30day = VALUES(completion_rate_30day),
        avg_release_time_minutes = VALUES(avg_release_time_minutes),
        avg_pay_time_minutes = VALUES(avg_pay_time_minutes),
        registered_days = VALUES(registered_days),
        first_trade_date = VALUES(first_trade_date),
        trading_counterparty_count = VALUES(trading_counterparty_count),
        all_trades_count = VALUES(all_trades_count),
        buy_orders_count = VALUES(buy_orders_count),
        sell_orders_count = VALUES(sell_orders_count),
        last_synced_at = NOW()
    `;

    return safe(
      pool.query(query, [
        buyerId,
        metricsData.trades_30day,
        metricsData.completion_rate_30day,
        metricsData.avg_release_time_minutes,
        metricsData.avg_pay_time_minutes,
        metricsData.registered_days,
        metricsData.first_trade_date,
        metricsData.trading_counterparty_count,
        metricsData.all_trades_count,
        metricsData.buy_orders_count,
        metricsData.sell_orders_count
      ]),
      `upsertBuyerMetrics:${buyerId}`
    );
  }

  async getBuyerMetrics(buyerId) {
    const query = 'SELECT * FROM seller_buyer_metrics WHERE buyer_id = ?';
    const [rows] = await pool.query(query, [buyerId]);
    return rows[0] || null;
  }

  async updateAdStatus(adNo, isActive) {
    const query = 'UPDATE seller_ads SET is_active = ?, updated_at = NOW() WHERE ad_no = ?';
    return safe(
      pool.query(query, [isActive, adNo]),
      `updateAdStatus:${adNo}`
    );
  }

  // ===== TRADE TYPES =====

  async createTradeType(sellerId, tradeTypeName) {
    const query = `
      INSERT INTO seller_trade_types (seller_id, trade_type_name, is_active)
      VALUES (?, ?, TRUE)
      ON DUPLICATE KEY UPDATE
        is_active = TRUE,
        updated_at = NOW()
    `;
    return safe(
      pool.query(query, [sellerId, tradeTypeName]),
      `createTradeType:${tradeTypeName}`
    );
  }

  async getTradeTypes(sellerId) {
    const query = `
      SELECT id, trade_type_name
      FROM seller_trade_types
      WHERE seller_id = ? AND is_active = TRUE
      ORDER BY trade_type_name ASC
    `;
    const [rows] = await pool.query(query, [sellerId]);
    return rows || [];
  }

  async deleteTradeType(sellerId, tradeTypeName) {
    const query = `
      UPDATE seller_trade_types
      SET is_active = FALSE
      WHERE seller_id = ? AND trade_type_name = ?
    `;
    return safe(
      pool.query(query, [sellerId, tradeTypeName]),
      `deleteTradeType:${tradeTypeName}`
    );
  }

  /**
   * Update ad rules in database
   * @param {string} adNo - Ad number
   * @param {object} updates - Fields to update (e.g., { min_30day_trades: 30, min_30day_trades_enabled: 1 })
   * @returns {Promise}
   */
  async updateAdRules(adNo, updates) {
    if (!adNo || !updates || Object.keys(updates).length === 0) {
      throw new Error('Ad number and updates required');
    }

    // Build SET clause dynamically
    const setClauses = Object.keys(updates).map(key => `${key} = ?`);
    const values = Object.values(updates);
    values.push(adNo);

    const query = `
      UPDATE seller_ad_rules
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE ad_no = ?
    `;

    return safe(
      pool.query(query, values),
      `updateAdRules:${adNo}`
    );
  }
}

module.exports = new SellerOrderDbService();
