-- Method 2 (document verification) attempt counters.
-- Each document gets up to 3 upload/verify attempts. When either exceeds 3 we
-- tell the buyer the limit is exceeded and stop.

ALTER TABLE seller_orders
  ADD COLUMN IF NOT EXISTS aadhaar_attempts INT DEFAULT 0 AFTER aadhaar_verified_at,
  ADD COLUMN IF NOT EXISTS pan_attempts     INT DEFAULT 0 AFTER pan_verified_at,
  -- Extracted values we keep for the record.
  ADD COLUMN IF NOT EXISTS aadhaar_name     VARCHAR(200) NULL AFTER aadhaar_attempts,
  ADD COLUMN IF NOT EXISTS pan_number       VARCHAR(20)  NULL AFTER pan_attempts,
  ADD COLUMN IF NOT EXISTS pan_name         VARCHAR(200) NULL AFTER pan_number;
