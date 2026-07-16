-- ===================================================================
-- ADD MISSING ELIGIBILITY ENABLED FLAGS
-- Migration to add enabled flag columns to seller_ad_rules table
-- ===================================================================

ALTER TABLE seller_ad_rules
ADD COLUMN min_30day_trades_enabled BOOLEAN DEFAULT TRUE AFTER ad_no,
ADD COLUMN min_30day_completion_rate_enabled BOOLEAN DEFAULT TRUE AFTER min_30day_trades,
ADD COLUMN max_avg_release_time_enabled BOOLEAN DEFAULT TRUE AFTER min_30day_completion_rate,
ADD COLUMN max_avg_pay_time_enabled BOOLEAN DEFAULT TRUE AFTER max_avg_release_time,
ADD COLUMN required_trade_type_enabled BOOLEAN DEFAULT TRUE AFTER max_avg_pay_time,
ADD COLUMN min_registered_days_enabled BOOLEAN DEFAULT TRUE AFTER required_trade_type,
ADD COLUMN min_first_trade_days_enabled BOOLEAN DEFAULT TRUE AFTER min_registered_days,
ADD COLUMN min_trading_counterparty_enabled BOOLEAN DEFAULT TRUE AFTER min_first_trade_days,
ADD COLUMN min_all_trades_count_enabled BOOLEAN DEFAULT TRUE AFTER min_trading_counterparty,
ADD COLUMN min_buy_orders_count_enabled BOOLEAN DEFAULT TRUE AFTER min_all_trades_count,
ADD COLUMN min_sell_orders_count_enabled BOOLEAN DEFAULT TRUE AFTER min_buy_orders_count;

-- ===================================================================
-- VERIFY THE MIGRATION
-- SELECT * FROM seller_ad_rules LIMIT 1;
-- ===================================================================
