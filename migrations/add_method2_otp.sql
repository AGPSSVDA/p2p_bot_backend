-- Method 2 OTP (mobile) verification — only runs when the ad has
-- method2_mobile_verification_enabled = 1. After Aadhaar + PAN are verified, the
-- bot asks the buyer for a 10-digit mobile number, sends an OTP via NettyFish SMS,
-- and verifies the OTP the buyer replies with in chat.
--
-- Retry rules (both capped at 3):
--   mobile_number_attempts : wrong/invalid mobile number entries
--   otp_attempts           : wrong OTP entries
-- Exceeding either → "limit exceeded, cancel the order".
--
-- mobile_verification_passed / mobile_verified_at already exist (Method 2/3 mobile).

ALTER TABLE seller_orders
  ADD COLUMN mobile_number          VARCHAR(15) NULL AFTER mobile_verified_at;

ALTER TABLE seller_orders
  ADD COLUMN otp_code               VARCHAR(10) NULL AFTER mobile_number;

ALTER TABLE seller_orders
  ADD COLUMN otp_sent_at            TIMESTAMP NULL AFTER otp_code;

ALTER TABLE seller_orders
  ADD COLUMN otp_attempts           INT DEFAULT 0 AFTER otp_sent_at;

ALTER TABLE seller_orders
  ADD COLUMN mobile_number_attempts INT DEFAULT 0 AFTER otp_attempts;
