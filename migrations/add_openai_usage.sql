-- OpenAI usage tracking.
-- Every OpenAI request logs its token usage + estimated cost here, so the admin
-- can see total spend, remaining credit, and per-request history.

CREATE TABLE IF NOT EXISTS openai_usage_log (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_number VARCHAR(30) NULL,
  model VARCHAR(50),
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  cost_usd DECIMAL(12,6) DEFAULT 0,   -- estimated cost of this request in USD
  purpose VARCHAR(50) DEFAULT 'document_verification',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_at (created_at),
  INDEX idx_order (order_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single-row config for the admin-entered purchased credit (OpenAI balance the
-- API can't fetch). remaining = credit_added_usd - SUM(cost_usd).
CREATE TABLE IF NOT EXISTS openai_credit_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  credit_added_usd DECIMAL(12,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO openai_credit_config (id, credit_added_usd)
SELECT 1, 0
WHERE NOT EXISTS (SELECT 1 FROM openai_credit_config WHERE id = 1);
