-- ===================================================================
-- ADD TRADE METHODS TABLE FOR SELLER ADS
-- This table stores payment methods from Binance for each ad
-- ===================================================================

CREATE TABLE IF NOT EXISTS seller_ad_trade_methods (
  id INT PRIMARY KEY AUTO_INCREMENT,

  ad_no VARCHAR(50) NOT NULL,
  seller_id VARCHAR(50) NOT NULL,

  -- Trade Method Details (from Binance)
  pay_id BIGINT,
  pay_type VARCHAR(50),  -- UPIQRCode, BankTransfer, etc.
  identifier VARCHAR(100),
  trade_method_name VARCHAR(100),
  icon_url VARCHAR(500),
  icon_url_color VARCHAR(500),
  commission_rate DECIMAL(5,4),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_ad_method (ad_no, pay_id),
  INDEX idx_seller_id (seller_id),
  INDEX idx_ad_no (ad_no),
  FOREIGN KEY (ad_no) REFERENCES seller_ads(ad_no) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- END MIGRATION
-- ===================================================================
