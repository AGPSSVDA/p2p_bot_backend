/**
 * QR code generator for Method 3 payment links.
 *
 * Easebuzz does not return a QR image, and Binance chat can only show an image by
 * URL (not raw bytes). So we render the payment link into a PNG QR ourselves, save
 * it under the app's public/ folder, and hand back a public URL the buyer can open
 * or scan. Fully self-hosted — no third-party QR service.
 *
 * The URL is built from APP_PUBLIC_URL (e.g. https://api.agpssvda.com) so it works
 * from the buyer's phone. Files are named by order so they're stable and easy to
 * clean up.
 */

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// public/qr lives next to the static mount (express.static(__dirname/../public)).
// From src/seller/services → ../../public.
const QR_DIR = path.join(__dirname, '..', '..', 'public', 'qr');

function ensureDir() {
  try {
    if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true });
  } catch (err) {
    logger.error(`QR dir create failed: ${err.message}`);
  }
}

/**
 * Render `data` (the payment link) to a PNG QR and return its public URL.
 * @param {string} data     the URL/text to encode
 * @param {string} orderNo  used to name the file
 * @returns {Promise<{success:boolean, url?:string, filePath?:string, message?:string}>}
 */
async function generatePaymentQr(data, orderNo) {
  if (!data) return { success: false, message: 'no data to encode' };
  ensureDir();

  // Safe filename from the order number.
  const safe = String(orderNo || 'order').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `pay_${safe}.png`;
  const filePath = path.join(QR_DIR, fileName);

  try {
    await QRCode.toFile(filePath, data, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 400,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    const base = (process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) {
      logger.warn('APP_PUBLIC_URL not set — QR saved but URL cannot be built');
      return { success: false, filePath, message: 'APP_PUBLIC_URL not configured' };
    }
    const url = `${base}/qr/${fileName}`;
    logger.info(`[${orderNo}] Payment QR generated`, { url });
    return { success: true, url, filePath };
  } catch (err) {
    logger.error(`[${orderNo}] QR generation failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

module.exports = { generatePaymentQr };
