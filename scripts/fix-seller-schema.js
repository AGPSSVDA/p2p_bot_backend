/**
 * FIX SELLER SCHEMA ON THE LIVE DB
 *
 * Symptom this fixes:
 *   "Unknown column 'classify' in 'field list'"  on upsertAd
 *   -> every ad fails to save, which then cascades into
 *   "foreign key constraint fails ... seller_ad_trade_methods"
 *   (the FK fails because the parent seller_ads row was never inserted)
 *
 * This script brings the live seller tables up to the schema the code expects.
 * It is IDEMPOTENT: it inspects the DB first and only adds what is missing,
 * so it is safe to run repeatedly. It never drops or modifies existing data.
 *
 * RUN THIS ON THE SERVER (it uses the server's .env DB credentials):
 *   node scripts/fix-seller-schema.js            # dry-run, shows what's missing
 *   node scripts/fix-seller-schema.js --apply    # apply the changes
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

const cfg = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  connectTimeout: 20000,
};

// Full column definitions the code expects on seller_ads.
// (Mirrors migrations/seller_tables.sql + later additions.)
const SELLER_ADS_COLUMNS = [
  ['ad_name', 'VARCHAR(200)'],
  ['ad_status', 'INT DEFAULT 0'],
  ['is_active', 'BOOLEAN DEFAULT TRUE'],
  ['classify', 'VARCHAR(50)'],
  ['trade_type', 'VARCHAR(10)'],
  ['asset', "VARCHAR(10) DEFAULT 'USDT'"],
  ['fiat_unit', "VARCHAR(10) DEFAULT 'INR'"],
  ['fiat_symbol', 'VARCHAR(5)'],
  ['price_rate', 'DECIMAL(18,8)'],
  ['price_type', 'INT'],
  ['price_floating_ratio', 'DECIMAL(5,2)'],
  ['commission_rate', 'DECIMAL(5,4)'],
  ['min_order_amount', 'DECIMAL(18,8)'],
  ['max_order_amount', 'DECIMAL(18,8)'],
  ['surplus_amount', 'DECIMAL(18,8)'],
  ['init_amount', 'DECIMAL(18,8)'],
  ['buyer_kyc_required', 'BOOLEAN DEFAULT FALSE'],
  ['buyer_reg_days_limit', 'INT DEFAULT 0'],
  ['buyer_btc_position_limit', 'DECIMAL(18,8)'],
  ['user_buy_trade_count_min', 'INT DEFAULT 0'],
  ['user_buy_trade_count_max', 'INT DEFAULT 99999'],
  ['user_sell_trade_count_min', 'INT DEFAULT 0'],
  ['user_sell_trade_count_max', 'INT DEFAULT 99999'],
  ['user_all_trade_count_min', 'INT DEFAULT 0'],
  ['user_all_trade_count_max', 'INT DEFAULT 99999'],
  ['user_trade_complete_count_min', 'INT DEFAULT 0'],
  ['user_trade_complete_rate_min', 'DECIMAL(5,2) DEFAULT 0.00'],
  ['user_trade_volume_min', 'DECIMAL(18,2)'],
  ['user_trade_volume_max', 'DECIMAL(18,2)'],
  ['pay_time_limit', 'INT'],
  ['remarks', 'TEXT'],
  ['auto_reply_msg', 'TEXT'],
  ['offline_reason', 'VARCHAR(100)'],
  ['asset_scale', 'INT'],
  ['fiat_scale', 'INT'],
  ['price_scale', 'INT'],
  ['binance_create_time', 'BIGINT'],
  ['binance_update_time', 'BIGINT'],
  ['total_orders', 'INT DEFAULT 0'],
  ['completed_orders', 'INT DEFAULT 0'],
  ['failed_orders', 'INT DEFAULT 0'],
];

const SELLER_AD_RULES_COLUMNS = [
  ['min_30day_trades_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_30day_completion_rate_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['max_avg_release_time_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['max_avg_pay_time_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['required_trade_type_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_registered_days_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_first_trade_days_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_trading_counterparty_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_all_trades_count_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_buy_orders_count_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_sell_orders_count_enabled', 'BOOLEAN DEFAULT TRUE'],
  ['min_trade_volume_enabled', 'BOOLEAN DEFAULT FALSE'],
  ['min_trade_volume', 'DECIMAL(18,2) DEFAULT 0'],
  ['max_trade_volume_enabled', 'BOOLEAN DEFAULT FALSE'],
  ['max_trade_volume', 'DECIMAL(18,2) DEFAULT 0'],
  ['min_btc_holding_enabled', 'BOOLEAN DEFAULT FALSE'],
  ['min_btc_holding', 'DECIMAL(18,8) DEFAULT 0'],
];

const SELLER_DOCS_COLUMNS = [
  ['image_url', 'VARCHAR(1000) NULL'],
  ['thumbnail_url', 'VARCHAR(1000) NULL'],
  ['image_type', 'VARCHAR(20) NULL'],
  ['image_width', 'INT NULL'],
  ['image_height', 'INT NULL'],
  ['chat_message_id', 'VARCHAR(64) NULL'],
  ['chat_message_uuid', 'VARCHAR(64) NULL'],
];

async function main() {
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  FIX SELLER SCHEMA — ${cfg.database} @ ${cfg.host}`);
  console.log(`  Mode: ${APPLY ? '🔴 APPLY' : '🟡 DRY-RUN (no changes)'}`);
  console.log(`${'='.repeat(62)}\n`);

  const c = await mysql.createConnection(cfg);
  console.log('✅ Connected\n');

  const existingCols = async (table) => {
    const [r] = await c.query(
      `SELECT column_name AS n FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?`, [cfg.database, table]
    );
    return r.map(x => x.n || x.COLUMN_NAME);
  };
  const tableExists = async (table) => {
    const [r] = await c.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`, [cfg.database, table]
    );
    return r[0].n > 0;
  };

  let pending = 0;

  async function syncTable(table, wanted) {
    if (!(await tableExists(table))) {
      console.log(`⚠️  ${table} — TABLE MISSING. Run migrations/seller_tables.sql first.`);
      return;
    }
    const have = await existingCols(table);
    const missing = wanted.filter(([col]) => !have.includes(col));
    console.log(`${table}: ${have.length} columns, ${missing.length} missing`);
    for (const [col, ddl] of missing) {
      pending++;
      console.log(`   + ${col} ${ddl}` + (APPLY ? '  — ADDING' : '  — would add'));
      if (APPLY) {
        await c.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`);
      }
    }
    if (missing.length === 0) console.log('   ✓ up to date');
    console.log('');
  }

  await syncTable('seller_ads', SELLER_ADS_COLUMNS);
  await syncTable('seller_ad_rules', SELLER_AD_RULES_COLUMNS);
  await syncTable('seller_verification_documents', SELLER_DOCS_COLUMNS);

  // unique index used to dedupe chat images
  if (await tableExists('seller_verification_documents')) {
    const [idx] = await c.query(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'seller_verification_documents'
         AND index_name = 'idx_order_chat_message'`, [cfg.database]
    );
    if (idx[0].n === 0) {
      pending++;
      console.log('seller_verification_documents: + unique index idx_order_chat_message' + (APPLY ? ' — ADDING' : ' — would add'));
      if (APPLY) {
        await c.query(`CREATE UNIQUE INDEX idx_order_chat_message
                       ON seller_verification_documents (order_number, chat_message_id)`);
      }
      console.log('');
    }
  }

  console.log('='.repeat(62));
  if (APPLY) {
    console.log(`  ✅ Done. ${pending} change(s) applied.`);
    console.log('  Now re-run the Binance sync — ads should save without errors.');
  } else if (pending === 0) {
    console.log('  ✅ Schema already up to date. Nothing to do.');
  } else {
    console.log(`  🟡 ${pending} change(s) needed. Apply with:`);
    console.log('     node scripts/fix-seller-schema.js --apply');
  }
  console.log('='.repeat(62) + '\n');

  await c.end();
  process.exit(0);
}

main().catch(e => {
  console.log('\n❌ Error:', e.code || '', e.message);
  process.exit(1);
});
