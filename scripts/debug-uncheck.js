require('dotenv').config();
const mysql = require('mysql2/promise');

async function debug() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('🔍 Checking database for uncheck state issues...\n');

    // Check a specific ad's rules
    const [adRules] = await connection.query(`
      SELECT 
        ad_no,
        min_30day_trades_enabled,
        min_30day_trades,
        min_30day_completion_rate_enabled,
        min_30day_completion_rate,
        min_registered_days_enabled,
        min_registered_days,
        min_all_trades_count_enabled,
        min_all_trades_count,
        min_buy_orders_count_enabled,
        min_buy_orders_count,
        min_sell_orders_count_enabled,
        min_sell_orders_count,
        min_trade_volume_enabled,
        min_trade_volume,
        max_trade_volume_enabled,
        max_trade_volume,
        min_btc_holding_enabled,
        min_btc_holding,
        updated_at
      FROM seller_ad_rules
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    if (adRules.length > 0) {
      const rule = adRules[0];
      console.log(`📊 Latest Ad Rules (ad_no: ${rule.ad_no})\n`);
      
      console.log('CORE CRITERIA:');
      console.log(`  min_30day_trades: enabled=${rule.min_30day_trades_enabled}, value=${rule.min_30day_trades}`);
      console.log(`  min_30day_completion_rate: enabled=${rule.min_30day_completion_rate_enabled}, value=${rule.min_30day_completion_rate}`);
      console.log(`  min_registered_days: enabled=${rule.min_registered_days_enabled}, value=${rule.min_registered_days}`);
      console.log(`  min_all_trades_count: enabled=${rule.min_all_trades_count_enabled}, value=${rule.min_all_trades_count}`);
      console.log(`  min_buy_orders_count: enabled=${rule.min_buy_orders_count_enabled}, value=${rule.min_buy_orders_count}`);
      console.log(`  min_sell_orders_count: enabled=${rule.min_sell_orders_count_enabled}, value=${rule.min_sell_orders_count}`);
      
      console.log('\nADVANCED OPTIONS:');
      console.log(`  min_trade_volume: enabled=${rule.min_trade_volume_enabled}, value=${rule.min_trade_volume}`);
      console.log(`  max_trade_volume: enabled=${rule.max_trade_volume_enabled}, value=${rule.max_trade_volume}`);
      console.log(`  min_btc_holding: enabled=${rule.min_btc_holding_enabled}, value=${rule.min_btc_holding}`);
      
      console.log(`\nLast Updated: ${rule.updated_at}`);
      
      // Check if any field shows as enabled but should be unchecked
      console.log('\n⚠️  ANALYSIS:');
      if (rule.min_30day_trades_enabled === 1 && rule.min_30day_trades === 0) {
        console.log('  ⚠️  min_30day_trades: Enabled but value=0 (Should be disabled?)');
      }
    } else {
      console.log('No rules found in database');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

debug();
