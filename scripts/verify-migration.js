require('dotenv').config();
const mysql = require('mysql2/promise');

async function verify() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    // Check all columns in seller_ad_rules
    const [allColumns] = await connection.query(`
      SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'seller_ad_rules'
      ORDER BY ORDINAL_POSITION DESC
    `);

    console.log('📊 Last 10 Columns in seller_ad_rules:\n');
    allColumns.slice(0, 10).forEach(col => {
      console.log(`✓ ${col.COLUMN_NAME}`);
      console.log(`  Type: ${col.COLUMN_TYPE}`);
      console.log(`  Default: ${col.COLUMN_DEFAULT || 'null'}`);
      console.log(`  Nullable: ${col.IS_NULLABLE}\n`);
    });

    // Check specifically for advanced options
    const [advancedCols] = await connection.query(`
      SHOW COLUMNS FROM seller_ad_rules 
      LIKE '%trade_volume%' OR LIKE '%btc_holding%'
    `);

    console.log('\n🔍 Advanced Options Columns:\n');
    if (advancedCols.length > 0) {
      console.log('✅ Advanced option columns exist:');
      advancedCols.forEach(col => {
        console.log(`   - ${col.Field} (${col.Type})`);
      });
    } else {
      console.log('⚠️  No advanced option columns found');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

verify();
