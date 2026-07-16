const logger = require('../../utils/logger');
const sellerBinanceService = require('../services/sellerBinanceService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerAdService = require('../services/sellerAdService');
const sellerBuyerMetricsService = require('../services/sellerBuyerMetricsService');
const { SellerOrderHandler } = require('./sellerOrderHandler');
const { SELLER_ORDER_STATES } = require('./sellerStateManager');
const { sellerConfig } = require('../config/sellerConfig');

/**
 * ===== SELLER ORDER POLLER =====
 *
 * Flow:
 * 1. Get ALL ads for this seller (from dashboard config)
 * 2. For EACH ad:
 *    - Poll Binance for orders on that specific ad
 *    - Get ad-specific rules (conditions + methods)
 *    - For each order: check if we're already processing it
 *    - Start orderHandler with ad-specific rules
 *
 * This is different from buyer poller:
 * - Buyer poller: Generic polling for all orders
 * - Seller poller: Polls per-ad, applies per-ad rules
 */
class SellerOrderPoller {
  constructor() {
    this.running = false;
    this.pollInterval = sellerConfig.orderPollInterval;
    this.processedOrders = new Set(); // Track orders already started
    this.sellerId = process.env.SELLER_ID; // Get from env or config
    this.orderHandler = new SellerOrderHandler(); // Create instance for handling orders
  }

  /**
   * Start the poller
   */
  start() {
    if (this.running) {
      console.log('⚠️ [SellerPoller] Already running');
      logger.warn('Seller order poller already running');
      return;
    }

    if (!this.sellerId) {
      console.error('❌ [SellerPoller] SELLER_ID not set in env');
      logger.error('SELLER_ID not configured in environment');
      return;
    }

    this.running = true;
    console.log(`\n🚀 [SellerPoller] STARTED (Seller ID: ${this.sellerId}, Interval: ${this.pollInterval}ms)\n`);
    logger.info('🚀 Seller Order Poller started', {
      interval: `${this.pollInterval}ms`,
      sellerId: this.sellerId
    });

    // Polling intervals live in memory, so a restart orphans any in-flight
    // document collection and images uploaded afterwards are lost forever.
    // Resume watching orders that were left in WAITING_DOCUMENTS.
    this.resumeDocumentCollection();

    this.poll();
  }

  /**
   * Resume Method 2 chat-image collection for orders stuck in WAITING_DOCUMENTS
   * (e.g. after a server restart).
   */
  async resumeDocumentCollection() {
    try {
      const pending = await sellerOrderDbService.getOrdersByState(
        SELLER_ORDER_STATES.WAITING_DOCUMENTS
      );

      if (!pending.length) return;

      console.log(`[SellerPoller] 🔄 Resuming document collection for ${pending.length} order(s) in WAITING_DOCUMENTS`);
      logger.info(`Resuming document image collection after restart`, {
        count: pending.length,
      });

      for (const order of pending) {
        console.log(`[SellerPoller]    ↻ ${order.order_number} (ad ${order.ad_no})`);
        await this.orderHandler.startDocumentImageCollection(order.order_number);
      }
    } catch (error) {
      logger.error(`Failed to resume document collection: ${error.message}`, { error });
    }
  }

  /**
   * Stop the poller
   */
  stop() {
    this.running = false;
    logger.info('⏹️ Seller Order Poller stopped');
  }

  /**
   * Main polling loop
   */
  async poll() {
    if (!this.running) return;

    try {
      await this.pollAllAds();
    } catch (error) {
      logger.error(`Seller poller error: ${error.message}`, { error });
    }

    // Schedule next poll
    setTimeout(() => this.poll(), this.pollInterval);
  }

  /**
   * ===== MAIN LOGIC =====
   * 1. Get all ads for seller
   * 2. For each ad: poll orders + apply rules
   */
  async pollAllAds() {
    try {
      // Step 1: Get all active ads for this seller
      const ads = await sellerOrderDbService.getAdsBySellerAndStatus(
        this.sellerId,
        true // isActive = true
      );

      if (ads.length === 0) {
        console.log(`[SellerPoller] ⚠️ No active ads found for seller ${this.sellerId}`);
        return;
      }

      console.log(`[SellerPoller] 📋 Found ${ads.length} active ads: ${ads.map(a => a.ad_no).join(', ')}`);
      logger.debug(`📋 Found ${ads.length} active ads`, {
        ads: ads.map(a => a.ad_no)
      });

      // Step 2: Poll each ad separately
      for (const ad of ads) {
        await this.pollOrdersForAd(ad);
      }

    } catch (error) {
      console.error(`[SellerPoller] ❌ Error polling ads:`, error.message);
      logger.error(`Error polling ads: ${error.message}`, { error });
    }
  }

  /**
   * ===== PER-AD POLLING =====
   * For ONE ad:
   * 1. Get ad's configuration (rules + methods)
   * 2. Poll Binance for orders on this ad
   * 3. For each order: apply ad-specific rules
   */
  async pollOrdersForAd(ad) {
    try {
      logger.debug(`📊 Polling orders for ad: ${ad.ad_no}`);

      // Step 1: Get ad configuration (11 rules + 3 methods with toggles)
      const adRules = await sellerOrderDbService.getAdRules(ad.ad_no);

      if (!adRules) {
        // Make this LOUD: with no rules row we skip the ad entirely, so every
        // order placed on it is silently ignored and nothing else is logged.
        console.log(`[SellerPoller] ⚠️  SKIPPING ad ${ad.ad_no} — no rules configured.`);
        console.log(`               Any order placed on this ad will NOT be detected.`);
        console.log(`               Fix: open this ad in the dashboard and save its verification methods.`);
        logger.warn(`No rules configured for ad ${ad.ad_no} - orders on this ad are ignored`, {
          adNo: ad.ad_no,
          message: 'Ad has no eligibility rules or verification methods set'
        });
        return; // Skip this ad if not configured
      }

      // Log ad configuration
      const ruleSummary = sellerAdService.getRuleSummary(adRules);
      logger.debug(`📌 Ad Config: ${ad.ad_no}`, {
        methods: ruleSummary.methods,
        minTradesCount: ruleSummary.minTradesCount,
        minCompletionRate: ruleSummary.minCompletionRate
      });

      // Step 2: Poll Binance for orders on this specific ad
      // Binance returns orders for ALL ads, so we filter by ad_no
      const allOrders = await this.fetchOrdersFromBinance();

      if (allOrders.length === 0) {
        console.log(`[SellerPoller] 📭 No orders found in Binance for ad ${ad.ad_no}`);
        return;
      }

      console.log(`[SellerPoller] 📦 Got ${allOrders.length} total orders from Binance`);

      // Filter: only orders for THIS ad
      // Try multiple field names since Binance response might vary
      const adOrders = allOrders.filter(o => {
        const orderAdId = o.adOrderNo || o.advNo || o.advOrderNo;
        return orderAdId === ad.ad_no;
      });

      if (adOrders.length === 0) {
        const orderAdIds = allOrders.map(o => o.adOrderNo || o.advNo || o.advOrderNo || 'UNKNOWN');
        console.log(`[SellerPoller] 🔍 Ad ${ad.ad_no}:`);
        console.log(`    Expected Ad ID: ${ad.ad_no}`);
        console.log(`    Orders found: ${orderAdIds.join(', ')}`);
        console.log(`    ❌ NO MATCH`);
        return;
      }

      console.log(`[SellerPoller] ✨ Found ${adOrders.length} new order(s) for ad ${ad.ad_no}:`,
        adOrders.map(o => ({ orderNo: o.orderNumber, buyer: o.counterPartNickName })));
      logger.info(`✨ Found ${adOrders.length} new order(s) for ad ${ad.ad_no}`);

      // Step 3: Process each order with ad-specific rules
      for (const order of adOrders) {
        await this.processOrderForAd(order, ad, adRules);
      }

    } catch (error) {
      logger.error(`Error polling ad ${ad.ad_no}: ${error.message}`, { error });
    }
  }

  /**
   * ===== PER-ORDER PROCESSING =====
   * For ONE order on ONE ad:
   * 1. Check if already being processed
   * 2. Fetch full order details + buyer info from Binance
   * 3. Get buyer metrics from Binance
   * 4. Start orderHandler with ad-specific rules
   */
  async processOrderForAd(order, ad, adRules) {
    const orderNo = order.orderNumber;

    try {
      // Check if order already in database
      const existingOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (existingOrder) {
        logger.debug(`Order ${orderNo} already in database, skipping`);
        return;
      }

      // Mark as being processed (to prevent duplicate DB inserts)
      if (this.processedOrders.has(orderNo)) {
        logger.debug(`Order ${orderNo} already being processed, skipping...`);
        return; // ← IMPORTANT: Don't process same order multiple times!
      }

      this.processedOrders.add(orderNo);

      console.log(`\n[SellerPoller] 🔍 Processing order ${orderNo}...`);

      // IMPORTANT: listOrders may return cached data
      // Fetch latest order details directly using getUserOrderDetail
      console.log(`  📡 Fetching LATEST order details from Binance...`);
      let latestOrderDetail = null;
      try {
        const orderStatusResponse = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
        if (orderStatusResponse.success) {
          latestOrderDetail = orderStatusResponse;
          console.log(`  ✅ Got latest order status from Binance`);

          // Additional-KYC ("liveness") detection is READ-ONLY.
          // The handler polls the order and waits for additionalKycVerify to change 1 -> 2.
          // We never call verifyAdditionalKyc() — that endpoint has a side effect of
          // marking the order verified, so calling it would skip the real buyer check.
          if (orderStatusResponse.additionalKycVerify === 1) {
            console.log(`  ⏳ Liveness pending (additionalKycVerify = 1)`);
            console.log(`     Handler will poll and wait for additionalKycVerify to become 2`);
          }
        }
      } catch (err) {
        console.log(`  ⚠️ Could not fetch latest details, using listOrders data`);
      }

      // Use latest data if available, otherwise use listOrders data
      const orderData = latestOrderDetail || order;
      const additionalKycVerify = latestOrderDetail?.additionalKycVerify || order.additionalKycVerify;

      // Step 2: Extract buyer info from order (available fields)
      const buyerNickname = order.buyerNickname || 'Unknown Buyer';
      const sellerNickname = order.sellerNickname || 'Unknown Seller';

      console.log(`  📋 Order Info:`);
      console.log(`     Buyer: ${buyerNickname}`);
      console.log(`     Seller: ${sellerNickname}`);
      console.log(`     Amount: ${order.totalPrice} ${order.fiat}`);
      console.log(`     Asset: ${order.amount} ${order.asset}`);
      console.log(`     Status: ${order.orderStatus} (1=WAIT_PAYMENT, 2=WAIT_RELEASE)`);
      console.log(`     Additional KYC: ${additionalKycVerify} (0=none, 1=liveness, 2=docs) [LATEST]`);
      console.log(`     Ad No: ${order.advNo}`);

      logger.info(`🆕 New order detected!`, {
        orderNo,
        buyer: buyerNickname,
        ad: ad.ad_no,
        amount: order.totalPrice
      });

      // NOTE: Eligibility check is done by Binance BEFORE order is placed
      // When buyer tries to place order on this ad, Binance checks if buyer meets
      // the criteria set for this ad. If not eligible, Binance rejects the order
      // with a message like: "Your registration time is less than 90 days..."
      //
      // Since order reached our poller, it means Binance already approved it.
      // We just need to process it.

      console.log(`  ✅ Order passed Binance eligibility check`);
      console.log(`  📊 Fetching buyer metrics for record...`);

      // Fetch full order details from Binance (includes buyer ID and other info)
      console.log(`  📡 Fetching full order details...`);
      const orderDetail = await this.fetchOrderDetail(orderNo);

      // Fetch buyer metrics for record-keeping
      const buyerMetrics = await this.fetchBuyerMetricsFromBinance(orderNo, buyerNickname);

      if (buyerMetrics) {
        console.log(`  ✅ Buyer profile:`);
        console.log(`     Trades (30d): ${buyerMetrics.trades_30day}`);
        console.log(`     Completion Rate: ${buyerMetrics.completion_rate_30day}%`);
        console.log(`     Registered Days: ${buyerMetrics.registered_days}`);
        console.log(`     All Trades: ${buyerMetrics.all_trades_count}`);

        // Store metrics in database for reference
        await sellerBuyerMetricsService.storeBuyerMetrics(buyerNickname, buyerMetrics);
      }

      // Start order handler to proceed with verification/payment flow
      console.log(`  ⚙️ Starting order handler...`);
      console.log(`  📋 Ad Rules Configuration:`, {
        method1_liveness_enabled: adRules?.method1_liveness_enabled,
        method2_documents_enabled: adRules?.method2_documents_enabled,
        method3_full_enabled: adRules?.method3_full_enabled
      });
      const enrichedOrder = {
        ...order,
        ...orderDetail,  // Merge full order details (includes counterPartUserId)
        additionalKycVerify: additionalKycVerify,  // ← Use LATEST value
        counterPartNickName: buyerNickname,
        buyerNickname: buyerNickname
      };
      await this.orderHandler.start(enrichedOrder, ad, adRules, buyerMetrics);
      console.log(`  ✨ Order processing started\n`);

    } catch (error) {
      console.error(`[SellerPoller] ❌ Error processing order ${orderNo}:`, error.message);
      logger.error(`Error processing order ${orderNo}: ${error.message}`, { error });
      this.processedOrders.delete(orderNo); // Remove from processing set so it can retry
    }
  }

  /**
   * Fetch full order details including buyer information
   * Endpoint: POST /sapi/v1/c2c/orderMatch/getUserOrderDetail
   * Takes the ORDER NUMBER (not the ad/adv number).
   */
  async fetchOrderDetail(orderNumber) {
    try {
      if (!orderNumber) return {};
      const detail = await sellerBinanceService.getOrderDetail(orderNumber);
      return detail || {};
    } catch (error) {
      logger.warn(`Error fetching order detail for ${orderNumber}: ${error.message}`);
      return {};
    }
  }


  /**
   * ===== BINANCE API CALL =====
   * Fetch all pending orders from Binance
   * Endpoint: POST /sapi/v1/c2c/orderMatch/listOrders
   * Returns: array of orders with adOrderNo (ad_no)
   * Uses seller-specific Binance config and API keys
   */
  async fetchOrdersFromBinance() {
    try {
      const orders = await sellerBinanceService.getPendingSellOrders();

      // Disabled verbose order logging - only enabled during debug
      // if (orders && orders.length > 0) {
      //   console.log(`\n[SellerPoller] 📋 Raw Orders from Binance (${orders.length}):`);
      //   orders.forEach((o, idx) => { ... });
      // }

      return orders || [];
    } catch (error) {
      logger.error(`Error fetching orders from Binance: ${error.message}`);
      return [];
    }
  }

  /**
   * ===== FETCH REAL BUYER METRICS FROM BINANCE =====
   * Endpoint: POST /sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic
   * Fetches buyer's trading history, completion rates, etc.
   * Uses seller-specific Binance config and API keys
   */
  async fetchBuyerMetricsFromBinance(orderNo, buyerNickname) {
    try {
      console.log(`     Calling queryCounterPartyOrderStatistic for order ${orderNo}...`);

      // Get counter party stats (trading history)
      const stats = await sellerBinanceService.getCounterPartyOrderStats(orderNo);

      console.log(`     Raw stats from Binance:`, JSON.stringify(stats, null, 2));

      // Calculate 30-day metrics (Binance returns total, we estimate 30-day from available data)
      // Note: For more accuracy, we could query additional endpoints for date-specific stats
      const buyerMetrics = {
        buyer_nickname: buyerNickname,
        trades_30day: stats.all_trades_count,  // Total trades (as proxy for 30-day)
        completion_rate_30day: stats.completion_rate_30day,
        registered_days: stats.registered_days,
        trading_counterparty_count: 0,  // Will be calculated from historical data
        all_trades_count: stats.all_trades_count,
        buy_orders_count: stats.buy_orders_count,
        sell_orders_count: stats.sell_orders_count,
        avg_release_time_minutes: 0,  // Needs additional endpoint call
        avg_pay_time_minutes: 0       // Needs additional endpoint call
      };

      logger.info(`✅ Buyer metrics fetched from Binance`, {
        buyer: buyerNickname,
        trades: buyerMetrics.all_trades_count,
        completionRate: buyerMetrics.completion_rate_30day
      });

      return buyerMetrics;

    } catch (error) {
      console.error(`     ❌ Error fetching metrics:`, error.message);
      logger.error(`Error fetching buyer metrics from Binance: ${error.message}`, { orderNo, buyer: buyerNickname });

      // Fallback to mock data for testing if Binance API fails
      console.log(`     Using mock data as fallback...`);
      logger.warn(`Using mock data as fallback for order ${orderNo}`);
      return this.createMockBuyerMetrics(buyerNickname);
    }
  }

  /**
   * ===== FALLBACK: MOCK BUYER METRICS (for testing/errors) =====
   * Used when Binance API is unavailable
   */
  createMockBuyerMetrics(buyerId) {
    return sellerBuyerMetricsService.createMockMetrics(buyerId, {
      trades_30day: Math.floor(Math.random() * 50) + 1,
      completion_rate_30day: Math.floor(Math.random() * 20) + 80,
      avg_release_time_minutes: Math.floor(Math.random() * 15) + 5,
      avg_pay_time_minutes: Math.floor(Math.random() * 10) + 3,
      registered_days: Math.floor(Math.random() * 300) + 30,
      trading_counterparty_count: Math.floor(Math.random() * 50) + 5,
      all_trades_count: Math.floor(Math.random() * 200) + 20,
      buy_orders_count: Math.floor(Math.random() * 100) + 10,
      sell_orders_count: Math.floor(Math.random() * 100) + 10
    });
  }

  /**
   * ===== STATS =====
   */
  getStats() {
    return {
      running: this.running,
      processingCount: this.processedOrders.size,
      sellerId: this.sellerId
    };
  }

  /**
   * Clear processed orders (useful for testing)
   */
  clearProcessedOrders() {
    this.processedOrders.clear();
    logger.info('Cleared processed orders cache');
  }
}

// Export singleton
module.exports = new SellerOrderPoller();
