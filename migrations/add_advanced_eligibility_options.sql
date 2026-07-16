-- ===================================================================
-- ADD ADVANCED ELIGIBILITY OPTIONS
-- Migration to persist advanced eligibility criteria columns
-- ===================================================================

ALTER TABLE seller_ad_rules
ADD COLUMN min_trade_volume_enabled BOOLEAN DEFAULT FALSE AFTER min_sell_orders_count,
ADD COLUMN min_trade_volume DECIMAL(18,2) DEFAULT 0 AFTER min_trade_volume_enabled,
ADD COLUMN max_trade_volume_enabled BOOLEAN DEFAULT FALSE AFTER min_trade_volume,
ADD COLUMN max_trade_volume DECIMAL(18,2) DEFAULT 0 AFTER max_trade_volume_enabled,
ADD COLUMN min_btc_holding_enabled BOOLEAN DEFAULT FALSE AFTER max_trade_volume,
ADD COLUMN min_btc_holding DECIMAL(18,8) DEFAULT 0 AFTER min_btc_holding_enabled;

-- ===================================================================
-- VERIFY THE COLUMNS WERE ADDED
-- SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
-- FROM INFORMATION_SCHEMA.COLUMNS
-- WHERE TABLE_NAME = 'seller_ad_rules'
-- AND COLUMN_NAME IN ('min_trade_volume_enabled', 'min_trade_volume', 'max_trade_volume_enabled', 'max_trade_volume', 'min_btc_holding_enabled', 'min_btc_holding')
-- ORDER BY ORDINAL_POSITION;
-- ===================================================================
