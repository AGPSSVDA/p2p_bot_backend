-- ===================================================================
-- SELLER-SIDE DATABASE SCHEMA
-- Step 1: Database Setup for Seller Order Management
-- ===================================================================

-- Table 1: Seller Ads Management
CREATE TABLE IF NOT EXISTS seller_ads (
  id INT PRIMARY KEY AUTO_INCREMENT,

  seller_id VARCHAR(50) NOT NULL,
  ad_no VARCHAR(50) UNIQUE NOT NULL,
  ad_name VARCHAR(200),

  -- Ad Status (from Binance)
  ad_status INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  classify VARCHAR(50),  -- profession, mass, etc.
  trade_type VARCHAR(10),  -- BUY, SELL

  -- Asset & Pricing
  asset VARCHAR(10) DEFAULT 'USDT',
  fiat_unit VARCHAR(10) DEFAULT 'INR',
  fiat_symbol VARCHAR(5),  -- ₹, $, €
  price_rate DECIMAL(18,8),
  price_type INT,  -- 1=FIXED, 2=FLOATING
  price_floating_ratio DECIMAL(5,2),  -- Floating percentage
  commission_rate DECIMAL(5,4),

  -- Order Amounts
  min_order_amount DECIMAL(18,8),
  max_order_amount DECIMAL(18,8),
  surplus_amount DECIMAL(18,8),  -- Available quantity
  init_amount DECIMAL(18,8),  -- Initial amount

  -- Buyer Requirements (from Binance)
  buyer_kyc_required BOOLEAN DEFAULT FALSE,
  buyer_reg_days_limit INT DEFAULT 0,
  buyer_btc_position_limit DECIMAL(18,8),

  -- Trade Count Limits
  user_buy_trade_count_min INT DEFAULT 0,
  user_buy_trade_count_max INT DEFAULT 99999,
  user_sell_trade_count_min INT DEFAULT 0,
  user_sell_trade_count_max INT DEFAULT 99999,
  user_all_trade_count_min INT DEFAULT 0,
  user_all_trade_count_max INT DEFAULT 99999,

  -- Completion Requirements
  user_trade_complete_count_min INT DEFAULT 0,
  user_trade_complete_rate_min DECIMAL(5,2) DEFAULT 0,

  -- Trade Volume
  user_trade_volume_min DECIMAL(18,2),
  user_trade_volume_max DECIMAL(18,2),

  -- Payment & Remarks
  pay_time_limit INT,  -- minutes
  remarks LONGTEXT,
  auto_reply_msg LONGTEXT,
  offline_reason VARCHAR(100),

  -- Decimal Precision
  asset_scale INT,
  fiat_scale INT,
  price_scale INT,

  -- Timestamps
  binance_create_time BIGINT,
  binance_update_time BIGINT,

  -- Statistics
  total_orders INT DEFAULT 0,
  completed_orders INT DEFAULT 0,
  failed_orders INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_seller_ad (seller_id, ad_no),
  INDEX idx_seller_id (seller_id),
  INDEX idx_is_active (is_active),
  INDEX idx_ad_no (ad_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 2: Seller Ad Rules (Per-Ad Configuration)
CREATE TABLE IF NOT EXISTS seller_ad_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,

  seller_id VARCHAR(50) NOT NULL,
  ad_no VARCHAR(50) NOT NULL,

  -- ===== BUYER ELIGIBILITY CRITERIA (11 fields - all configurable) =====
  -- Each criterion has an enabled flag and a value
  min_30day_trades_enabled BOOLEAN DEFAULT TRUE,
  min_30day_trades INT DEFAULT 0,
  min_30day_completion_rate_enabled BOOLEAN DEFAULT TRUE,
  min_30day_completion_rate DECIMAL(5,2) DEFAULT 0.00,
  max_avg_release_time_enabled BOOLEAN DEFAULT TRUE,
  max_avg_release_time INT DEFAULT 0,
  max_avg_pay_time_enabled BOOLEAN DEFAULT TRUE,
  max_avg_pay_time INT DEFAULT 0,
  required_trade_type_enabled BOOLEAN DEFAULT TRUE,
  required_trade_type VARCHAR(20) DEFAULT 'ANY',
  min_registered_days_enabled BOOLEAN DEFAULT TRUE,
  min_registered_days INT DEFAULT 0,
  min_first_trade_days_enabled BOOLEAN DEFAULT TRUE,
  min_first_trade_days INT DEFAULT 0,
  min_trading_counterparty_enabled BOOLEAN DEFAULT TRUE,
  min_trading_counterparty INT DEFAULT 0,
  min_all_trades_count_enabled BOOLEAN DEFAULT TRUE,
  min_all_trades_count INT DEFAULT 0,
  min_buy_orders_count_enabled BOOLEAN DEFAULT TRUE,
  min_buy_orders_count INT DEFAULT 0,
  min_sell_orders_count_enabled BOOLEAN DEFAULT TRUE,
  min_sell_orders_count INT DEFAULT 0,

  -- ===== VERIFICATION METHODS (Toggles) =====
  -- Method 1: Liveness Check
  method1_liveness_enabled BOOLEAN DEFAULT FALSE,

  -- Method 2: Identity Documents
  method2_documents_enabled BOOLEAN DEFAULT FALSE,
  method2_mobile_verification_enabled BOOLEAN DEFAULT FALSE,

  -- Method 3: Full Verification
  method3_full_enabled BOOLEAN DEFAULT FALSE,
  method3_mobile_verification_enabled BOOLEAN DEFAULT FALSE,
  method3_payment_link_enabled BOOLEAN DEFAULT FALSE,
  method3_payment_gateway VARCHAR(20) DEFAULT 'razorpay',
  method3_delivery_method VARCHAR(20) DEFAULT 'payment_link',

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_seller_ad_rules (seller_id, ad_no),
  INDEX idx_seller_id (seller_id),
  INDEX idx_ad_no (ad_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 3: Seller Orders (Main tracking table)
CREATE TABLE IF NOT EXISTS seller_orders (
  id INT PRIMARY KEY AUTO_INCREMENT,

  -- ===== ORDER IDENTIFICATION =====
  order_number VARCHAR(20) UNIQUE NOT NULL,
  seller_id VARCHAR(50) NOT NULL,
  buyer_id VARCHAR(50) NOT NULL,
  buyer_nickname VARCHAR(100),
  ad_no VARCHAR(50) NOT NULL,

  -- ===== ORDER DETAILS =====
  crypto_amount DECIMAL(18,8),
  fiat_amount DECIMAL(18,2),
  asset VARCHAR(10),
  fiat_unit VARCHAR(10),

  -- ===== BUYER KYC INFO =====
  buyer_kyc_name VARCHAR(200),

  -- ===== STEP 2: ELIGIBILITY CHECK =====
  eligibility_check_completed_at TIMESTAMP NULL,
  eligibility_check_passed BOOLEAN DEFAULT NULL,
  eligibility_check_failed_reason VARCHAR(500),

  -- ===== STEP 3A: LIVENESS VERIFICATION =====
  liveness_requested_at TIMESTAMP NULL,
  liveness_completed_at TIMESTAMP NULL,
  liveness_passed BOOLEAN DEFAULT NULL,

  -- ===== STEP 3B: DOCUMENT VERIFICATION =====
  -- Aadhaar
  aadhaar_upload_requested_at TIMESTAMP NULL,
  aadhaar_uploaded_at TIMESTAMP NULL,
  aadhaar_verified_at TIMESTAMP NULL,
  aadhaar_verification_passed BOOLEAN DEFAULT NULL,

  -- PAN
  pan_upload_requested_at TIMESTAMP NULL,
  pan_uploaded_at TIMESTAMP NULL,
  pan_verified_at TIMESTAMP NULL,
  pan_verification_passed BOOLEAN DEFAULT NULL,

  -- Mobile OTP (Optional)
  mobile_requested_at TIMESTAMP NULL,
  mobile_uploaded_at TIMESTAMP NULL,
  mobile_verified_at TIMESTAMP NULL,
  mobile_verification_passed BOOLEAN DEFAULT NULL,

  -- ===== STEP 4: ORDER VERIFICATION =====
  order_verify_attempted_at TIMESTAMP NULL,
  order_verified_at TIMESTAMP NULL,
  order_verify_failed_reason VARCHAR(500),

  -- ===== STEP 5: PAYMENT (Method 3 Only) =====
  payment_link_generated_at TIMESTAMP NULL,
  payment_link_sent_at TIMESTAMP NULL,
  payment_link_expires_at TIMESTAMP NULL,

  payment_webhook_received_at TIMESTAMP NULL,
  payment_received_at TIMESTAMP NULL,
  payment_utr VARCHAR(50),
  payment_gateway VARCHAR(20),
  payment_amount DECIMAL(18,2),

  -- ===== STEP 6: THANK YOU MESSAGE =====
  thank_you_message_sent_at TIMESTAMP NULL,

  -- ===== STATE & STATUS =====
  current_state VARCHAR(100),
  order_status INT,
  last_error_message VARCHAR(500),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_seller_id (seller_id),
  INDEX idx_buyer_id (buyer_id),
  INDEX idx_ad_no (ad_no),
  INDEX idx_order_status (order_status),
  INDEX idx_current_state (current_state),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 4: Seller Verification Documents
CREATE TABLE IF NOT EXISTS seller_verification_documents (
  id INT PRIMARY KEY AUTO_INCREMENT,

  order_number VARCHAR(20) NOT NULL,
  buyer_id VARCHAR(50) NOT NULL,

  document_type VARCHAR(20),
  document_hash VARCHAR(64),
  document_size INT,

  uploaded_at TIMESTAMP NULL,

  surepass_request_id VARCHAR(100),
  surepass_response JSON,

  verification_status VARCHAR(50),
  verification_error VARCHAR(500),
  verified_at TIMESTAMP NULL,

  FOREIGN KEY (order_number) REFERENCES seller_orders(order_number),
  INDEX idx_order_number (order_number),
  INDEX idx_buyer_id (buyer_id),
  INDEX idx_document_type (document_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 5: Seller Order Messages (Audit trail)
CREATE TABLE IF NOT EXISTS seller_order_messages (
  id INT PRIMARY KEY AUTO_INCREMENT,

  order_number VARCHAR(20) NOT NULL,

  direction VARCHAR(10),
  sender VARCHAR(50),
  message_type VARCHAR(50),
  message_content LONGTEXT,

  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  binance_msg_id VARCHAR(100),

  FOREIGN KEY (order_number) REFERENCES seller_orders(order_number),
  INDEX idx_order_number (order_number),
  INDEX idx_direction (direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 6: Seller Order State Log (State transitions)
CREATE TABLE IF NOT EXISTS seller_order_state_log (
  id INT PRIMARY KEY AUTO_INCREMENT,

  order_number VARCHAR(20) NOT NULL,

  from_state VARCHAR(100),
  to_state VARCHAR(100),
  reason VARCHAR(500),

  transitioned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (order_number) REFERENCES seller_orders(order_number),
  INDEX idx_order_number (order_number),
  INDEX idx_to_state (to_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 7: Seller Payment History (Payment tracking for Method 3)
CREATE TABLE IF NOT EXISTS seller_payment_history (
  id INT PRIMARY KEY AUTO_INCREMENT,

  order_number VARCHAR(20) NOT NULL,

  payment_method VARCHAR(20),
  amount_inr DECIMAL(18,2),
  transaction_id VARCHAR(100),
  utr VARCHAR(50),

  initiated_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,

  status VARCHAR(50),
  error_message VARCHAR(500),

  webhook_received_at TIMESTAMP NULL,
  webhook_data JSON,

  FOREIGN KEY (order_number) REFERENCES seller_orders(order_number),
  INDEX idx_order_number (order_number),
  INDEX idx_payment_method (payment_method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 8: Seller Buyer Metrics (Cached buyer metrics from Binance)
CREATE TABLE IF NOT EXISTS seller_buyer_metrics (
  id INT PRIMARY KEY AUTO_INCREMENT,

  buyer_id VARCHAR(50) UNIQUE NOT NULL,

  -- Metrics fetched from Binance
  trades_30day INT DEFAULT 0,
  completion_rate_30day DECIMAL(5,2) DEFAULT 0,
  avg_release_time_minutes INT DEFAULT 0,
  avg_pay_time_minutes INT DEFAULT 0,
  registered_days INT DEFAULT 0,
  first_trade_date TIMESTAMP NULL,
  trading_counterparty_count INT DEFAULT 0,
  all_trades_count INT DEFAULT 0,
  buy_orders_count INT DEFAULT 0,
  sell_orders_count INT DEFAULT 0,

  -- Sync tracking
  last_synced_at TIMESTAMP NULL,

  INDEX idx_buyer_id (buyer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- END OF SELLER SCHEMA
-- ===================================================================
