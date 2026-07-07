-- ===================================================================
-- ADD TRADE TYPES TABLE
-- This table allows admins to create custom trade types
-- ===================================================================

CREATE TABLE IF NOT EXISTS seller_trade_types (
  id INT PRIMARY KEY AUTO_INCREMENT,

  seller_id VARCHAR(50) NOT NULL,
  trade_type_name VARCHAR(100) NOT NULL,

  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_seller_trade_type (seller_id, trade_type_name),
  INDEX idx_seller_id (seller_id),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- END MIGRATION
-- ===================================================================
