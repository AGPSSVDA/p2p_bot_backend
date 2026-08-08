-- Method 3 payment gateway (Easebuzz) support.
--
-- Method 3 = Method 1 (liveness) + Method 2 (documents, + optional OTP) + a
-- payment-gateway step. After the order is verified, the bot sends the buyer a
-- payment link / QR for the EXACT order amount. On payment success the bot
-- verifies the payer (name match where available) and releases the crypto.

-- ── Ad-level config ──────────────────────────────────────────────────────────
-- method3_full_enabled already exists. When it's on, the admin MUST pick a
-- payment gateway (method3_payment_gateway). method3_mobile_verification_enabled
-- (OTP) is OPTIONAL. method3_payment_gateway already exists but defaulted to
-- 'razorpay' — Method 3 now uses 'easebuzz' (the only gateway wired for now).
-- method3_delivery_method already exists ('payment_link' | 'qr_code').
-- No new ad columns needed — we reuse the existing method3_* columns.

-- ── Order-level payment tracking ─────────────────────────────────────────────
ALTER TABLE seller_orders
  ADD COLUMN payment_gateway        VARCHAR(30)  NULL AFTER mobile_number_attempts;

ALTER TABLE seller_orders
  ADD COLUMN payment_link           TEXT         NULL AFTER payment_gateway;

ALTER TABLE seller_orders
  ADD COLUMN payment_txn_id         VARCHAR(80)  NULL AFTER payment_link;

ALTER TABLE seller_orders
  ADD COLUMN payment_easepayid      VARCHAR(80)  NULL AFTER payment_txn_id;

ALTER TABLE seller_orders
  ADD COLUMN payment_amount         DECIMAL(18,2) NULL AFTER payment_easepayid;

ALTER TABLE seller_orders
  ADD COLUMN payment_status         VARCHAR(30)  NULL AFTER payment_amount;

ALTER TABLE seller_orders
  ADD COLUMN payment_payer_name     VARCHAR(200) NULL AFTER payment_status;

ALTER TABLE seller_orders
  ADD COLUMN payment_mode           VARCHAR(30)  NULL AFTER payment_payer_name;

ALTER TABLE seller_orders
  ADD COLUMN payment_link_sent_at   TIMESTAMP NULL AFTER payment_mode;

ALTER TABLE seller_orders
  ADD COLUMN payment_received_at    TIMESTAMP NULL AFTER payment_link_sent_at;

ALTER TABLE seller_orders
  ADD COLUMN crypto_released_at     TIMESTAMP NULL AFTER payment_received_at;
