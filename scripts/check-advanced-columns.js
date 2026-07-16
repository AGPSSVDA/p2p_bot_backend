require('dotenv').config();
const mysql = require('mysql2/promise');

async function check() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    const [cols] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'seller_ad_rules' AND COLUMN_NAME LIKE 'min_trade%'
    `);
    
    console.log('Columns with min_trade prefix:', cols);
    
    const [cols2] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'seller_ad_rules' AND COLUMN_NAME LIKE '%btc%'
    `);
    
    console.log('Columns with btc in name:', cols2);

    if (cols.length === 0 && cols2.length === 0) {
      console.log('\n❌ Advanced option columns NOT ADDED YET');
      console.log('Running ALTER TABLE query...\n');
      
      const alterQuery = `ALTER TABLE seller_ad_rules
        ADD COLUMN min_trade_volume_enabled BOOLEAN DEFAULT FALSE AFTER min_sell_orders_count,
        ADD COLUMN min_trade_volume DECIMAL(18,2) DEFAULT 0 AFTER min_trade_volume_enabled,
        ADD COLUMN max_trade_volume_enabled BOOLEAN DEFAULT FALSE AFTER min_trade_volume,
        ADD COLUMN max_trade_volume DECIMAL(18,2) DEFAULT 0 AFTER max_trade_volume_enabled,
        ADD COLUMN min_btc_holding_enabled BOOLEAN DEFAULT FALSE AFTER max_trade_volume,
        ADD COLUMN min_btc_holding DECIMAL(18,8) DEFAULT 0 AFTER min_btc_holding_enabled`;
      
      await connection.query(alterQuery);
      console.log('✅ ALTER TABLE executed!\n');
      
      // Verify again
      const [newCols] = await connection.query(`
        SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'seller_ad_rules' 
        AND (COLUMN_NAME LIKE 'min_trade%' OR COLUMN_NAME LIKE 'max_trade%' OR COLUMN_NAME LIKE '%btc%')
      `);
      
      console.log('✅ New columns added:\n');
      newCols.forEach(col => {
        console.log(`   ✓ ${col.COLUMN_NAME} (${col.COLUMN_TYPE})`);
      });
    } else {
      console.log('✅ Advanced option columns already exist!');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

check();
