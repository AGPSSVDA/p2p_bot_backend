/**
 * TOTP (Google Authenticator) code generator for seller-side crypto release.
 *
 * Binance's releaseCoin can require a 2FA code when the account has Google
 * Authenticator enabled. That code (googleVerifyCode) is a time-based one-time
 * password that changes every 30 seconds, so a STATIC env code is useless — it's
 * stale the moment it's saved. This service regenerates a fresh code on demand
 * from the account's 2FA secret (the 16+ char base32 "setup key" shown when you
 * enable Google Authenticator on Binance).
 *
 * Set SELLER_RELEASE_2FA_SECRET to that base32 secret. If it's not set, this
 * returns null and the caller falls back to a code-less release (works when the
 * account/endpoint doesn't require 2FA) or to manual release.
 *
 * Binance uses standard TOTP: base32 secret, SHA-1, 6 digits, 30-second period —
 * exactly what Google Authenticator produces, so speakeasy's defaults match.
 */

const speakeasy = require('speakeasy');
const logger = require('../../utils/logger');

/**
 * Generate the current Google-Authenticator code from the configured 2FA secret.
 * @returns {string|null} 6-digit code, or null if no secret is configured/invalid.
 */
function currentGoogleCode() {
  const secret = (process.env.SELLER_RELEASE_2FA_SECRET || '').replace(/\s+/g, '');
  if (!secret) return null;
  try {
    return speakeasy.totp({ secret, encoding: 'base32' });
  } catch (err) {
    logger.error(`TOTP generation failed: ${err.message}`);
    return null;
  }
}

/** True if a 2FA secret is configured (so auto-release can attempt a code). */
function hasSecret() {
  return !!(process.env.SELLER_RELEASE_2FA_SECRET || '').replace(/\s+/g, '');
}

module.exports = { currentGoogleCode, hasSecret };
