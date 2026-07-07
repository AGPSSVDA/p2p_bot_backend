const logger = require('../../utils/logger');

/**
 * Seller State Machine Constants
 * States for tracking order through all 6 steps
 */
const SELLER_ORDER_STATES = {
  // Initial
  NEW_ORDER: 'NEW_ORDER',

  // Step 2: Eligibility Check
  CHECKING_ELIGIBILITY: 'CHECKING_ELIGIBILITY',
  ELIGIBILITY_PASSED: 'ELIGIBILITY_PASSED',
  ELIGIBILITY_FAILED: 'ELIGIBILITY_FAILED',

  // Step 3A: Liveness Verification (if enabled)
  WAITING_LIVENESS: 'WAITING_LIVENESS',
  LIVENESS_COMPLETED: 'LIVENESS_COMPLETED',
  LIVENESS_TIMEOUT: 'LIVENESS_TIMEOUT',

  // Step 3B: Document Verification (if enabled)
  WAITING_DOCUMENTS: 'WAITING_DOCUMENTS',
  DOCUMENTS_UPLOADED: 'DOCUMENTS_UPLOADED',
  VERIFYING_DOCUMENTS: 'VERIFYING_DOCUMENTS',
  DOCUMENTS_VERIFIED: 'DOCUMENTS_VERIFIED',
  DOCUMENTS_VERIFICATION_FAILED: 'DOCUMENTS_VERIFICATION_FAILED',

  // Step 3B: Mobile OTP (if enabled in Method 2/3)
  WAITING_MOBILE_OTP: 'WAITING_MOBILE_OTP',
  MOBILE_OTP_VERIFIED: 'MOBILE_OTP_VERIFIED',
  MOBILE_OTP_FAILED: 'MOBILE_OTP_FAILED',

  // Step 4: Order Verification in Binance
  VERIFYING_ORDER: 'VERIFYING_ORDER',
  ORDER_VERIFIED: 'ORDER_VERIFIED',
  ORDER_VERIFY_FAILED: 'ORDER_VERIFY_FAILED',

  // Step 5: Payment (Method 3 only)
  PAYMENT_LINK_SENT: 'PAYMENT_LINK_SENT',
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',

  // Step 6: Thank you & completion
  SENDING_THANK_YOU: 'SENDING_THANK_YOU',
  COMPLETED: 'COMPLETED',

  // Failures
  REJECTED: 'REJECTED'
};

/**
 * Seller State Manager
 * In-memory state tracking for orders being processed
 * Combined with DB persistence in sellerOrderDbService
 */
class SellerStateManager {
  constructor() {
    this.orders = {}; // orderNo -> { state, data, createdAt, updatedAt }
    this.stateHistory = {}; // orderNo -> [{ state, timestamp }]
  }

  /**
   * Add new order to state manager
   */
  add(orderData) {
    const { orderNumber } = orderData;

    this.orders[orderNumber] = {
      orderNumber: orderData.orderNumber,
      sellerId: orderData.sellerId,
      buyerId: orderData.buyerId,
      buyerNickname: orderData.buyerNickname,
      buyerKycName: orderData.buyerKycName,
      adNo: orderData.adNo,
      cryptoAmount: orderData.cryptoAmount,
      fiatAmount: orderData.fiatAmount,

      state: SELLER_ORDER_STATES.NEW_ORDER,

      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Initialize state history
    this.stateHistory[orderNumber] = [
      { state: SELLER_ORDER_STATES.NEW_ORDER, timestamp: Date.now() }
    ];

    logger.info(`[${orderNumber}] Order registered`, {
      buyer: orderData.buyerNickname,
      ad: orderData.adNo
    });
  }

  /**
   * Transition order to new state
   */
  setState(orderNumber, newState, metadata = {}) {
    if (!this.orders[orderNumber]) {
      logger.warn(`Order not found in state manager`, { orderNumber });
      return false;
    }

    const order = this.orders[orderNumber];
    const oldState = order.state;

    // Validate state transition (optional - can be strict or permissive)
    order.state = newState;
    order.updatedAt = Date.now();
    Object.assign(order, metadata);

    // Record in history
    this.stateHistory[orderNumber].push({
      state: newState,
      timestamp: Date.now(),
      from: oldState
    });

    logger.info(`[${orderNumber}] State transition: ${oldState} → ${newState}`);

    return true;
  }

  /**
   * Get current state
   */
  getState(orderNumber) {
    const order = this.orders[orderNumber];
    return order ? order.state : null;
  }

  /**
   * Get full order object
   */
  get(orderNumber) {
    return this.orders[orderNumber] || null;
  }

  /**
   * Check if order exists in state manager
   */
  has(orderNumber) {
    return !!this.orders[orderNumber];
  }

  /**
   * Remove order from state manager
   * Called after order is completed/failed
   */
  remove(orderNumber) {
    if (this.orders[orderNumber]) {
      delete this.orders[orderNumber];
      logger.debug(`Order removed from state manager`, { orderNumber });
      return true;
    }
    return false;
  }

  /**
   * Get state history for order
   */
  getHistory(orderNumber) {
    return this.stateHistory[orderNumber] || [];
  }

  /**
   * Print stats
   */
  printStats() {
    const count = Object.keys(this.orders).length;
    const states = {};

    Object.values(this.orders).forEach(order => {
      states[order.state] = (states[order.state] || 0) + 1;
    });

    logger.info(`📊 Seller Orders in Memory`, {
      total: count,
      states
    });
  }

  /**
   * Get all orders in specific state
   */
  getOrdersByState(state) {
    return Object.values(this.orders).filter(o => o.state === state);
  }
}

module.exports = {
  SellerStateManager,
  SELLER_ORDER_STATES
};
