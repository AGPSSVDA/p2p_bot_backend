-- Per-ad re-order cooldown: after a buyer COMPLETES an order on this ad, block
-- them from placing a new one for a configurable number of hours.
--
-- Was hardcoded to 24h for all ads. Now per-ad + toggleable:
--   reorder_cooldown_enabled : 0 = OFF (buyer can re-order immediately), 1 = ON
--   reorder_cooldown_hours   : how many hours to block (only when enabled)
--
-- Default OFF so existing ads have NO restriction unless the admin turns it on.

ALTER TABLE seller_ad_rules
  ADD COLUMN reorder_cooldown_enabled TINYINT(1) DEFAULT 0;

ALTER TABLE seller_ad_rules
  ADD COLUMN reorder_cooldown_hours   INT DEFAULT 24;
