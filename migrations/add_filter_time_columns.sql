-- Admin-selectable "Filter Time" for eligibility criteria.
-- Binance uses these to scope a requirement to Last 30 Days (1) or All-time (2).
-- Previously hardcoded in the sync controller; now editable per ad.
--
--   user_trade_count_filter_time  -> userTradeCountFilterTime
--        scopes min 30-day trades (userTradeCompleteCountMin) AND
--        all-trades count (userAllTradeCountMin). Default 1 = Last 30D.
--   completion_rate_filter_time   -> userTradeCompleteRateFilterTime
--        scopes the completion-rate requirement. Default 1 = Last 30D.
--   trade_volume_filter_time      -> userTradeVolumeFilterTime
--        scopes the trade-volume requirement. Default 2 = All-time.
--
-- Values: 1 = Last 30 Days, 2 = All-time (matches Binance enum exactly).
-- Defaults preserve the old hardcoded behaviour so existing ads are unchanged.

ALTER TABLE seller_ad_rules
  ADD COLUMN user_trade_count_filter_time TINYINT NOT NULL DEFAULT 1
    COMMENT '1=Last30D, 2=Alltime; scopes trade-count criteria',
  ADD COLUMN completion_rate_filter_time  TINYINT NOT NULL DEFAULT 1
    COMMENT '1=Last30D, 2=Alltime; scopes completion-rate criterion',
  ADD COLUMN trade_volume_filter_time     TINYINT NOT NULL DEFAULT 2
    COMMENT '1=Last30D, 2=Alltime; scopes trade-volume criteria';
