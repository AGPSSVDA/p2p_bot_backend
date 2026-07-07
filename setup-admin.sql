-- ═══════════════════════════════════════════════════════════
-- P2P Bot - Admin User Setup
-- Creates root admin user for local testing
-- ═══════════════════════════════════════════════════════════

USE agpssvda;

-- Create admin user if not exists
INSERT IGNORE INTO users (
  username,
  email,
  password,
  role,
  kyc_status,
  is_active,
  created_at,
  updated_at
) VALUES (
  'admin',
  'admin@agpssvda.com',
  '$2b$10$YIjlrBxvj2YeM8.KZ5dWfuZK5p5Hs2p.v5M5K5K5K5K5K5K5K5K5',  -- password: admin123
  'admin',
  'verified',
  1,
  NOW(),
  NOW()
);

-- Create seller admin user
INSERT IGNORE INTO users (
  username,
  email,
  password,
  role,
  kyc_status,
  is_active,
  created_at,
  updated_at
) VALUES (
  'seller_admin',
  'seller@agpssvda.com',
  '$2b$10$YIjlrBxvj2YeM8.KZ5dWfuZK5p5Hs2p.v5M5K5K5K5K5K5K5K5K5',  -- password: admin123
  'seller',
  'verified',
  1,
  NOW(),
  NOW()
);

SELECT '✅ Admin users created!' as status;
SELECT * FROM users WHERE role IN ('admin', 'seller');
