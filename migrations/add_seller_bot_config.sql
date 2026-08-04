-- Seller bot on/off state, persisted across restarts.
-- bot_status: 1 = running, 0 = stopped. On startup the poller reads this and
-- only starts if it's 1, so a stop survives a server restart.

CREATE TABLE IF NOT EXISTS seller_bot_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bot_status TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ensure a single config row exists (default: running).
INSERT INTO seller_bot_config (id, bot_status)
SELECT 1, 1
WHERE NOT EXISTS (SELECT 1 FROM seller_bot_config WHERE id = 1);
