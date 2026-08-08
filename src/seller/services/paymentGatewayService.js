/**
 * Payment gateway abstraction (Method 3).
 *
 * Gives the handler one gateway-agnostic interface:
 *   createLink(gateway, { orderNo, amount, name, phone, email })
 *   getStatus(gateway, merchantTxn)
 *
 * Only 'easebuzz' is wired today. To add another gateway later, implement the
 * same two functions in its service and register it in GATEWAYS below — no
 * handler changes needed.
 */

const easebuzz = require('./easebuzzService');
const logger = require('../../utils/logger');

const GATEWAYS = {
  easebuzz: {
    createLink: (p) => easebuzz.createPaymentLink(p),
    getStatus: (txn) => easebuzz.getTransaction(txn),
  },
  // e.g. anothergateway: { createLink: ..., getStatus: ... }
};

function resolve(gateway) {
  const g = GATEWAYS[String(gateway || '').toLowerCase()];
  return g || null;
}

async function createLink(gateway, params) {
  const g = resolve(gateway);
  if (!g) {
    logger.error('Unknown payment gateway', { gateway });
    return { success: false, message: `Unknown payment gateway: ${gateway}` };
  }
  return g.createLink(params);
}

async function getStatus(gateway, merchantTxn) {
  const g = resolve(gateway);
  if (!g) return { success: false, message: `Unknown payment gateway: ${gateway}` };
  return g.getStatus(merchantTxn);
}

function isSupported(gateway) {
  return !!resolve(gateway);
}

module.exports = { createLink, getStatus, isSupported, GATEWAYS };
