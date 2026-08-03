/**
 * PRE-DEPLOY CHECK (read-only)
 *
 * Verifies that the target DB has every column/table the new code needs, and
 * that required env vars are set. Reports what's MISSING — it does NOT change
 * anything. Run this against the LIVE DB before deploying.
 *
 * Uses TARGET_DB_* env vars so you never accidentally check the local .env DB:
 *   TARGET_DB_HOST=1.2.3.4 TARGET_DB_USER=u TARGET_DB_PASS=p TARGET_DB_NAME=db \
 *     node scripts/predeploy-check.js
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

const cfg = {
  host: process.env.TARGET_DB_HOST || process.env.DB_HOST,
  user: process.env.TARGET_DB_USER || process.env.DB_USER,
  password: process.env.TARGET_DB_PASS || process.env.DB_PASS,
  database: process.env.TARGET_DB_NAME || process.env.DB_NAME,
  port: Number(process.env.TARGET_DB_PORT || process.env.DB_PORT) || 3306,
  connectTimeout: 20000,
};

// Columns each table must have for the new features.
const REQUIRE = {
  seller_orders: [
    'aadhaar_attempts', 'pan_attempts', 'aadhaar_name', 'pan_number', 'pan_name',
  ],
  seller_verification_documents: [
    'image_url', 'thumbnail_url', 'image_type', 'image_width', 'image_height',
    'chat_message_id', 'chat_message_uuid',
  ],
  seller_ad_rules: [
    'min_trade_volume', 'max_trade_volume', 'min_btc_holding',
    'min_30day_trades_enabled', 'min_30day_completion_rate_enabled',
  ],
};

const REQUIRE_TABLES = ['seller_ad_trade_methods', 'seller_trade_types'];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PRE-DEPLOY CHECK — ${cfg.database} @ ${cfg.host}`);
  console.log(`${'='.repeat(60)}\n`);

  // ---- ENV ----
  console.log('ENV VARS:');
  const env = (k, needed) => {
    const v = process.env[k];
    console.log(`  ${v ? '✅' : (needed ? '❌ MISSING' : '⚠️  not set')}  ${k}` + (v ? '' : needed ? '  (REQUIRED)' : '  (optional)'));
  };
  env('OPENAI_API_KEY', true);
  env('OPENAI_VISION_MODEL', false);
  env('OPENAI_VISION_DETAIL', false);
  env('SUREPASS_API_TOKEN', true);
  console.log('');

  // ---- DB ----
  const c = await mysql.createConnection(cfg);
  console.log('✅ DB connected\n');

  let missing = 0;

  for (const table of REQUIRE_TABLES) {
    const [r] = await c.query(
      'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=? AND table_name=?',
      [cfg.database, table]
    );
    const ok = r[0].n > 0;
    if (!ok) missing++;
    console.log(`TABLE ${table}: ${ok ? '✅ exists' : '❌ MISSING'}`);
  }
  console.log('');

  for (const [table, cols] of Object.entries(REQUIRE)) {
    const [r] = await c.query(
      'SELECT column_name AS n FROM information_schema.columns WHERE table_schema=? AND table_name=?',
      [cfg.database, table]
    );
    const have = r.map((x) => x.n || x.COLUMN_NAME);
    const gaps = cols.filter((col) => !have.includes(col));
    if (gaps.length) {
      missing += gaps.length;
      console.log(`${table}: ❌ missing ${gaps.length} column(s): ${gaps.join(', ')}`);
    } else {
      console.log(`${table}: ✅ all required columns present`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (missing === 0) {
    console.log('  ✅ DB SCHEMA READY. No migration needed.');
  } else {
    console.log(`  ⚠️  ${missing} item(s) missing. Run the migrations before deploy:`);
    console.log('     1) migrations/seller_tables.sql          (if seller tables absent)');
    console.log('     2) migrations/add_eligibility_enabled_flags.sql');
    console.log('     3) migrations/add_advanced_eligibility_options.sql');
    console.log('     4) migrations/add_seller_trade_methods.sql');
    console.log('     5) migrations/add_trade_types_table.sql');
    console.log('     6) migrations/add_document_image_columns.sql');
    console.log('     7) migrations/add_method2_attempt_columns.sql   <-- NEW (Method 2)');
    console.log('  Or use the idempotent runner: scripts/migrate-live.js --apply');
  }
  console.log(`${'='.repeat(60)}\n`);

  await c.end();
  process.exit(0);
}

main().catch((e) => { console.log('❌ Error:', e.code || '', e.message); process.exit(1); });
