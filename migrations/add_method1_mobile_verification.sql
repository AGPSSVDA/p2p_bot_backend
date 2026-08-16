-- Optional OTP (mobile) verification for Method 1 (Liveness).
-- When enabled, after the buyer completes liveness the bot asks for a mobile
-- number, sends an OTP (same NettyFish flow + templates as Method 2), verifies
-- the reply, and only then verifies the order in Binance. When disabled, the
-- order is verified right after liveness (unchanged behaviour).
--
-- Mirrors method2_mobile_verification_enabled. Default 0 = off, so existing
-- Method 1 ads keep working exactly as before.

ALTER TABLE seller_ad_rules
  ADD COLUMN method1_mobile_verification_enabled TINYINT NOT NULL DEFAULT 0
    COMMENT 'Method 1: require mobile OTP after liveness (0=off, 1=on)';
