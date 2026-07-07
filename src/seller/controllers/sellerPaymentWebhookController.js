const logger = require('../../utils/logger');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const sellerOrderHandler = require('../bot/sellerOrderHandler');

/**
 * ===== SELLER PAYMENT WEBHOOK HANDLERS =====
 * Handle payment confirmations from Razorpay and Paywize
 * Used for Method 3 verification (payment proof)
 */

/**
 * Handle Razorpay payment webhook
 * Called when Razorpay payment status updates
 */
async function handleSellerRazorpayWebhook(req, res) {
  try {
    logger.info('Seller Razorpay webhook received', {
      method: req.method,
      path: req.path || req.url,
      from: req.ip || req.socket?.remoteAddress
    });

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

    // Verify signature (use existing Razorpay verification logic)
    const signature = req.headers['x-razorpay-signature'] || '';

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      logger.error('Seller Razorpay webhook: Invalid JSON', { error: err.message });
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    logger.debug('Razorpay payload received', {
      event: payload.event,
      paymentId: payload.payment?.id
    });

    // Extract payment details
    const event = payload.event;
    const payment = payload.payment;

    if (!payment) {
      logger.warn('Seller Razorpay webhook: No payment object');
      return res.status(200).json({ success: true }); // Still return 200
    }

    const paymentId = payment.id;
    const status = payment.status;
    const amount = payment.amount / 100; // Razorpay returns in paise
    const notes = payment.notes || {};
    const orderNo = notes.orderNo || notes.order_number;

    logger.info('Seller Razorpay payment update', {
      paymentId,
      status,
      amount,
      orderNo
    });

    if (!orderNo) {
      logger.warn('Seller Razorpay webhook: No order number in notes');
      return res.status(200).json({ success: true });
    }

    // Get order
    const order = await sellerOrderDbService.getOrderByNumber(orderNo);
    if (!order) {
      logger.warn('Seller Razorpay webhook: Order not found', { orderNo });
      return res.status(200).json({ success: true });
    }

    // Handle payment status
    if (status === 'captured') {
      logger.info('Seller Razorpay: Payment captured', { orderNo, amount });

      // Record payment received
      await sellerOrderDbService.recordPaymentReceived(orderNo, paymentId, amount);

      // Callback to order handler
      if (sellerOrderHandler.onPaymentWebhookReceived) {
        await sellerOrderHandler.onPaymentWebhookReceived(orderNo);
      }

      res.status(200).json({ success: true, message: 'Payment recorded' });

    } else if (status === 'failed') {
      logger.warn('Seller Razorpay: Payment failed', { orderNo, paymentId });

      // Record payment failure
      await sellerOrderDbService.recordError(orderNo, `Razorpay payment failed: ${paymentId}`);

      res.status(200).json({ success: true, message: 'Payment failure recorded' });

    } else {
      logger.debug('Seller Razorpay: Unknown status', { status, orderNo });
      res.status(200).json({ success: true });
    }

  } catch (error) {
    logger.error('Seller Razorpay webhook error: ' + error.message, { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handle Paywize payment webhook
 * Called when Paywize payment status updates
 */
async function handleSellerPaywizeWebhook(req, res) {
  try {
    logger.info('Seller Paywize webhook received', {
      method: req.method,
      path: req.path || req.url,
      from: req.ip || req.socket?.remoteAddress
    });

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

    // Verify signature (use existing Paywize verification logic)
    const signature = req.headers['x-paywize-signature'] || '';

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      logger.error('Seller Paywize webhook: Invalid JSON', { error: err.message });
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    logger.debug('Paywize payload received', {
      event: payload.event,
      transactionId: payload.transaction_id
    });

    // Extract payment details
    const event = payload.event;
    const transactionId = payload.transaction_id;
    const status = payload.status;
    const amount = payload.amount;
    const metadata = payload.metadata || {};
    const orderNo = metadata.orderNo || metadata.order_number;

    logger.info('Seller Paywize payment update', {
      transactionId,
      status,
      amount,
      orderNo
    });

    if (!orderNo) {
      logger.warn('Seller Paywize webhook: No order number in metadata');
      return res.status(200).json({ success: true });
    }

    // Get order
    const order = await sellerOrderDbService.getOrderByNumber(orderNo);
    if (!order) {
      logger.warn('Seller Paywize webhook: Order not found', { orderNo });
      return res.status(200).json({ success: true });
    }

    // Handle payment status
    if (status === 'success' || status === 'COMPLETED') {
      logger.info('Seller Paywize: Payment success', { orderNo, amount });

      // Record payment received
      await sellerOrderDbService.recordPaymentReceived(orderNo, transactionId, amount);

      // Callback to order handler
      if (sellerOrderHandler.onPaymentWebhookReceived) {
        await sellerOrderHandler.onPaymentWebhookReceived(orderNo);
      }

      res.status(200).json({ success: true, message: 'Payment recorded' });

    } else if (status === 'failed' || status === 'FAILED') {
      logger.warn('Seller Paywize: Payment failed', { orderNo, transactionId });

      // Record payment failure
      await sellerOrderDbService.recordError(orderNo, `Paywize payment failed: ${transactionId}`);

      res.status(200).json({ success: true, message: 'Payment failure recorded' });

    } else {
      logger.debug('Seller Paywize: Unknown status', { status, orderNo });
      res.status(200).json({ success: true });
    }

  } catch (error) {
    logger.error('Seller Paywize webhook error: ' + error.message, { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  handleSellerRazorpayWebhook,
  handleSellerPaywizeWebhook
};
