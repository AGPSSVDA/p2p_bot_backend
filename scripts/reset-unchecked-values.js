require('dotenv').config();
const mysql = require('mysql2/promise');

async function resetValues() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('🔄 RESETTING UNCHECKED VALUES TO 0\n');
    
    // For each field, if enabled=0, set value=0
    const updates = [
      { field: 'min_30day_trades', enabled_col: 'min_30day_trades_enabled' },
      { field: 'min_30day_completion_rate', enabled_col: 'min_30day_completion_rate_enabled' },
      { field: 'min_registered_days', enabled_col: 'min_registered_days_enabled' },
      { field: 'min_all_trades_count', enabled_col: 'min_all_trades_count_enabled' },
      { field: 'min_buy_orders_count', enabled_col: 'min_buy_orders_count_enabled' },
      { field: 'min_sell_orders_count', enabled_col: 'min_sell_orders_count_enabled' },
      { field: 'min_trade_volume', enabled_col: 'min_trade_volume_enabled' },
      { field: 'max_trade_volume', enabled_col: 'max_trade_volume_enabled' },
      { field: 'min_btc_holding', enabled_col: 'min_btc_holding_enabled' }
    ];

    for (const update of updates) {
      const query = `
        UPDATE seller_ad_rules
        SET ${update.field} = 0
        WHERE ${update.enabled_col} = 0
      `;
      
      const [result] = await connection.query(query);
      
      if (result.affectedRows > 0) {
        console.log(`✅ ${update.field}: Reset ${result.affectedRows} rows where unchecked`);
      }
    }

    console.log('\n✅ ALL UNCHECKED VALUES RESET TO 0\n');

    // Verify
    const [verification] = await connection.query(`
      SELECT 
        ad_no,
        min_30day_trades_enabled, min_30day_trades,
        min_trade_volume_enabled, min_trade_volume,
        max_trade_volume_enabled, max_trade_volume,
        min_btc_holding_enabled, min_btc_holding
      FROM seller_ad_rules
      WHERE ad_no = '13900814235866066944'
    `);

    if (verification.length > 0) {
      const rule = verification[0];
      console.log('📊 VERIFICATION (Ad 13900814235866066944):\n');
      console.log('✓ min_30day_trades: enabled=' + rule.min_30day_trades_enabled + ', value=' + rule.min_30day_trades);
      console.log('✓ min_trade_volume: enabled=' + rule.min_trade_volume_enabled + ', value=' + rule.min_trade_volume);
      console.log('✓ max_trade_volume: enabled=' + rule.max_trade_volume_enabled + ', value=' + rule.max_trade_volume);
      console.log('✓ min_btc_holding: enabled=' + rule.min_btc_holding_enabled + ', value=' + rule.min_btc_holding);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

resetValues();
