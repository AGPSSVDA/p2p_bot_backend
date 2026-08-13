-- Editable SMS OTP config (text + DLT template id) so the admin can change the
-- OTP template AND its matching DLT Template Id together from the frontend.
-- The DLT-registered template id changes whenever the approved text changes, so
-- they must be edited as a pair — env alone can't keep them in sync at runtime.
--
-- Single-row table (id = 1). Other SMS params (sender id, API key, PEID, route)
-- stay in env — they rarely change. Empty values fall back to env / defaults.

CREATE TABLE IF NOT EXISTS seller_sms_config (
  id INT PRIMARY KEY DEFAULT 1,
  otp_template   TEXT NULL,          -- OTP SMS text; {otp} = the code (DLT {#var#})
  dlt_template_id VARCHAR(60) NULL,  -- DLT Template Id matching the text above
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO seller_sms_config (id, otp_template, dlt_template_id)
SELECT 1, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM seller_sms_config WHERE id = 1);
