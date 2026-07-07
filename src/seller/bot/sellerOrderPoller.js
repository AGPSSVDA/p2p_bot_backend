const logger = require('../../utils/logger');
const binanceService = require('../../services/binanceService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerAdService = require('../services/sellerAdService');
const sellerBuyerMetricsService = require('../services/sellerBuyerMetricsService');
const { SellerOrderHandler } = require('./sellerOrderHandler');
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
  }

  /**
   * Start the poller
   */
  start() {
    if (this.running) {
      logger.warn('Seller order poller already running');
      return;
    }

    if (!this.sellerId) {
      logger.error('SELLER_ID not configured in environment');
      return;
    }

    this.running = true;
    logger.info('🚀 Seller Order Poller started', {
      interval: `${this.pollInterval}ms`,
      sellerId: this.sellerId
    });

    this.poll();
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
        logger.debug('No active ads found for seller', { sellerId: this.sellerId });
        return;
      }

      logger.debug(`📋 Found ${ads.length} active ads`, {
        ads: ads.map(a => a.ad_no)
      });

      // Step 2: Poll each ad separately
      for (const ad of ads) {
        await this.pollOrdersForAd(ad);
      }

    } catch (error) {
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
        logger.warn(`No rules configured for ad ${ad.ad_no}`, {
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
        logger.debug(`No orders found in Binance for ad ${ad.ad_no}`);
        return;
      }

      // Filter: only orders for THIS ad
      const adOrders = allOrders.filter(o => o.adOrderNo === ad.ad_no);

      if (adOrders.length === 0) {
        logger.debug(`No new orders for ad ${ad.ad_no}`);
        return;
      }

      logger.info(`✨ Found ${adOrders.length} new orders for ad ${ad.ad_no}`);

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
   * 2. Get buyer metrics from Binance
   * 3. Start orderHandler with ad-specific rules
   */
  async processOrderForAd(order, ad, adRules) {
    const orderNo = order.orderNumber;

    try {
      // Step 1: Check if already processing this order
      if (this.processedOrders.has(orderNo)) {
        logger.debug(`Order ${orderNo} already being processed, skipping`);
        return;
      }

      // Check if order already in database
      const existingOrder = await sellerOrderDbService.getOrderByNumber(orderNo);
      if (existingOrder) {
        logger.debug(`Order ${orderNo} already in database, skipping`);
        return;
      }

      logger.info(`🆕 New order detected!`, {
        orderNo,
        buyer: order.counterPartNickName,
        ad: ad.ad_no,
        amount: order.totalPrice
      });

      // Mark as being processed
      this.processedOrders.add(orderNo);

      // Step 2: Fetch buyer metrics from Binance (or mock data)
      // In production: call Binance API to get buyer's 30-day stats
      // For now: mock metrics
      const buyerMetrics = this.createMockBuyerMetrics(order.counterPartUserId);

      // Step 3: Start order handler with:
      // - Raw order data from Binance
      // - Ad object (ad_no, seller_id, etc)
      // - Ad-specific rules (conditions + methods)
      // - Buyer metrics
      await SellerOrderHandler.start(order, ad, adRules, buyerMetrics);

    } catch (error) {
      logger.error(`Error processing order ${orderNo}: ${error.message}`, { error });
      this.processedOrders.delete(orderNo); // Remove from processing set so it can retry
    }
  }

  /**
   * ===== BINANCE API CALL =====
   * Fetch all pending orders from Binance
   * Returns: array of orders with adOrderNo (ad_no)
   */
  async fetchOrdersFromBinance() {
    try {
      // Call Binance SAPI v7.4 endpoint
      // GET /sapi/v1/c2c/orderMatch/listOrders
      // Filter: tradeType='SELL', status ∈ [0,1] (new, unpaid)

      const orders = await binanceService.getPendingSellOrders();

      return orders || [];

    } catch (error) {
      logger.error(`Error fetching orders from Binance: ${error.message}`);
      return [];
    }
  }

  /**
   * ===== MOCK BUYER METRICS (for testing) =====
   * In production: fetch real metrics from Binance
   * For now: return mock data
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
