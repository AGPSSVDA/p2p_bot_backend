/**
 * Run Database Migration
 * Executes the add_advanced_eligibility_options migration
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('🔄 Running migration: add_advanced_eligibility_options.sql');
    console.log(`📊 Database: ${process.env.DB_NAME}`);
    console.log(`🖥️  Host: ${process.env.DB_HOST}\n`);

    // Read migration file
    const migrationPath = path.join(__dirname, '../migrations/add_advanced_eligibility_options.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // Extract actual SQL (remove comments)
    const sqlStatements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--'));

    // Execute each statement
    for (const statement of sqlStatements) {
      if (statement) {
        console.log(`⏳ Executing:\n${statement.substring(0, 100)}...\n`);
        await connection.query(statement);
        console.log('✅ Done\n');
      }
    }

    console.log('✅ Migration completed successfully!');

    // Verify columns were added
    console.log('\n📋 Verifying columns were added...\n');

    const [columns] = await connection.query(`
      SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'seller_ad_rules'
      AND COLUMN_NAME IN ('min_trade_volume_enabled', 'min_trade_volume', 'max_trade_volume_enabled', 'max_trade_volume', 'min_btc_holding_enabled', 'min_btc_holding')
      ORDER BY ORDINAL_POSITION
    `);

    if (columns.length === 6) {
      console.log('✅ All 6 new columns added successfully:\n');
      columns.forEach(col => {
        console.log(`   ✓ ${col.COLUMN_NAME}`);
        console.log(`     Type: ${col.COLUMN_TYPE}`);
        console.log(`     Default: ${col.COLUMN_DEFAULT || 'FALSE'}\n`);
      });
    } else {
      console.log(`⚠️  Expected 6 columns, found ${columns.length}`);
      console.log(columns);
    }

    // Show total columns in table
    const [totalColumns] = await connection.query(`
      SELECT COUNT(*) as total
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'seller_ad_rules'
    `);

    console.log(`\n📊 Total columns in seller_ad_rules: ${totalColumns[0].total}`);

  } catch (error) {
    console.error('❌ Migration failed:');
    console.error(error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration().then(() => {
  console.log('\n✅ All done!');
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
