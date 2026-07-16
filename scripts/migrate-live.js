/**
 * LIVE DB MIGRATION RUNNER (idempotent)
 *
 * Applies ONLY the migrations missing from the live DB, in dependency order.
 * Safe to re-run: every step checks whether the column/table/index already
 * exists before altering, so nothing is duplicated or dropped.
 *
 * Reads DB credentials from .env (DB_HOST/DB_USER/DB_PASS/DB_NAME/DB_PORT).
 *
 * Usage:
 *   node scripts/migrate-live.js          # dry-run: shows what WOULD run
 *   node scripts/migrate-live.js --apply  # actually apply the changes
 */

const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

// Target the LIVE DB explicitly via TARGET_* env vars so we never accidentally
// migrate the local DB from .env. Example:
//   TARGET_DB_HOST=198.38.81.34 TARGET_DB_USER=... node scripts/migrate-live.js
if (!process.env.TARGET_DB_HOST) {
  console.log('❌ Refusing to run: set TARGET_DB_HOST/USER/PASS/NAME for the LIVE db.');
  console.log('   This prevents accidentally migrating the local .env database.');
  process.exit(1);
}

const cfg = {
  host: process.env.TARGET_DB_HOST,
  user: process.env.TARGET_DB_USER,
  password: process.env.TARGET_DB_PASS,
  database: process.env.TARGET_DB_NAME,
  port: Number(process.env.TARGET_DB_PORT) || 3306,
  connectTimeout: 20000,
  multipleStatements: false,
};

async function columnExists(c, table, column) {
  const [r] = await c.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [cfg.database, table, column]
  );
  return r[0].n > 0;
}

async function tableExists(c, table) {
  const [r] = await c.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ?`,
    [cfg.database, table]
  );
  return r[0].n > 0;
}

async function indexExists(c, table, indexName) {
  const [r] = await c.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
    [cfg.database, table, indexName]
  );
  return r[0].n > 0;
}

async function addColumn(c, table, column, ddl) {
  if (await columnExists(c, table, column)) {
    console.log(`   • ${table}.${column} — already exists, skip`);
    return;
  }
  console.log(`   + ${table}.${column}` + (APPLY ? ' — ADDING' : ' — would add'));
  if (APPLY) await c.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  LIVE DB MIGRATION  (${cfg.database} @ ${cfg.host})`);
  console.log(`  Mode: ${APPLY ? '🔴 APPLY (writes changes)' : '🟡 DRY-RUN (no changes)'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!cfg.host || !cfg.user || !cfg.database) {
    console.log('❌ DB_HOST/DB_USER/DB_NAME missing in .env');
    process.exit(1);
  }

  const c = await mysql.createConnection(cfg);
  console.log('✅ Connected\n');

  // ---- 1) Eligibility enabled-flag columns on seller_ad_rules ----
  console.log('1) seller_ad_rules — eligibility enabled flags');
  const enabledFlags = [
    ['min_30day_trades_enabled', 'min_30day_trades_enabled BOOLEAN DEFAULT TRUE'],
    ['min_30day_completion_rate_enabled', 'min_30day_completion_rate_enabled BOOLEAN DEFAULT TRUE'],
    ['max_avg_release_time_enabled', 'max_avg_release_time_enabled BOOLEAN DEFAULT TRUE'],
    ['max_avg_pay_time_enabled', 'max_avg_pay_time_enabled BOOLEAN DEFAULT TRUE'],
    ['required_trade_type_enabled', 'required_trade_type_enabled BOOLEAN DEFAULT TRUE'],
    ['min_registered_days_enabled', 'min_registered_days_enabled BOOLEAN DEFAULT TRUE'],
    ['min_first_trade_days_enabled', 'min_first_trade_days_enabled BOOLEAN DEFAULT TRUE'],
    ['min_trading_counterparty_enabled', 'min_trading_counterparty_enabled BOOLEAN DEFAULT TRUE'],
    ['min_all_trades_count_enabled', 'min_all_trades_count_enabled BOOLEAN DEFAULT TRUE'],
    ['min_buy_orders_count_enabled', 'min_buy_orders_count_enabled BOOLEAN DEFAULT TRUE'],
    ['min_sell_orders_count_enabled', 'min_sell_orders_count_enabled BOOLEAN DEFAULT TRUE'],
  ];
  for (const [col, ddl] of enabledFlags) await addColumn(c, 'seller_ad_rules', col, ddl);

  // ---- 2) Advanced eligibility options on seller_ad_rules ----
  console.log('\n2) seller_ad_rules — advanced eligibility options');
  const advanced = [
    ['min_trade_volume_enabled', 'min_trade_volume_enabled BOOLEAN DEFAULT FALSE'],
    ['min_trade_volume', 'min_trade_volume DECIMAL(18,2) DEFAULT 0'],
    ['max_trade_volume_enabled', 'max_trade_volume_enabled BOOLEAN DEFAULT FALSE'],
    ['max_trade_volume', 'max_trade_volume DECIMAL(18,2) DEFAULT 0'],
    ['min_btc_holding_enabled', 'min_btc_holding_enabled BOOLEAN DEFAULT FALSE'],
    ['min_btc_holding', 'min_btc_holding DECIMAL(18,8) DEFAULT 0'],
  ];
  for (const [col, ddl] of advanced) await addColumn(c, 'seller_ad_rules', col, ddl);

  // ---- 3) Document image columns on seller_verification_documents ----
  console.log('\n3) seller_verification_documents — chat image columns');
  const imageCols = [
    ['image_url', 'image_url VARCHAR(1000) NULL'],
    ['thumbnail_url', 'thumbnail_url VARCHAR(1000) NULL'],
    ['image_type', 'image_type VARCHAR(20) NULL'],
    ['image_width', 'image_width INT NULL'],
    ['image_height', 'image_height INT NULL'],
    ['chat_message_id', 'chat_message_id VARCHAR(64) NULL'],
    ['chat_message_uuid', 'chat_message_uuid VARCHAR(64) NULL'],
  ];
  for (const [col, ddl] of imageCols) await addColumn(c, 'seller_verification_documents', col, ddl);

  // unique index for idempotent chat-image inserts
  if (await indexExists(c, 'seller_verification_documents', 'idx_order_chat_message')) {
    console.log('   • idx_order_chat_message — already exists, skip');
  } else {
    console.log('   + idx_order_chat_message (unique)' + (APPLY ? ' — ADDING' : ' — would add'));
    if (APPLY) {
      await c.query(
        `CREATE UNIQUE INDEX idx_order_chat_message
         ON seller_verification_documents (order_number, chat_message_id)`
      );
    }
  }

  // Helper: run the CREATE TABLE statements from a migration .sql file verbatim,
  // so table definitions always match the committed migration exactly.
  async function createFromFile(fileName) {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', fileName), 'utf8');
    const statements = sql
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length && /create|insert|alter|index/i.test(s));
    for (const st of statements) await c.query(st);
  }

  // ---- 4) seller_ad_trade_methods table ----
  console.log('\n4) seller_ad_trade_methods table');
  if (await tableExists(c, 'seller_ad_trade_methods')) {
    console.log('   • table exists, skip');
  } else {
    console.log('   + creating table' + (APPLY ? ' — CREATING' : ' — would create'));
    if (APPLY) await createFromFile('add_seller_trade_methods.sql');
  }

  // ---- 5) seller_trade_types table ----
  console.log('\n5) seller_trade_types table');
  if (await tableExists(c, 'seller_trade_types')) {
    console.log('   • table exists, skip');
  } else {
    console.log('   + creating table' + (APPLY ? ' — CREATING' : ' — would create'));
    if (APPLY) await createFromFile('add_trade_types_table.sql');
  }

  console.log(`\n${'='.repeat(60)}`);
  if (APPLY) {
    console.log('  ✅ Migration applied.');
  } else {
    console.log('  🟡 Dry-run complete. Re-run with --apply to make changes:');
    console.log('     node scripts/migrate-live.js --apply');
  }
  console.log(`${'='.repeat(60)}\n`);

  await c.end();
  process.exit(0);
}

main().catch(e => {
  console.log('\n❌ Migration error:', e.code || '', e.message);
  process.exit(1);
});
