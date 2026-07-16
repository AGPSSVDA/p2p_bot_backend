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
    const adNo = '13900814235866066944';
    
    const [rule] = await connection.query(`
      SELECT 
        min_30day_trades_enabled,
        min_30day_trades,
        MAX(updated_at) as updated_at
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    if (rule.length > 0) {
      const r = rule[0];
      console.log(`Database State (Ad ${adNo}):`);
      console.log(`  min_30day_trades_enabled: ${r.min_30day_trades_enabled} (type: ${typeof r.min_30day_trades_enabled})`);
      console.log(`  min_30day_trades: ${r.min_30day_trades}`);
      console.log(`  Last Updated: ${r.updated_at}`);
      console.log(`\nType values: 0 = false/unchecked, 1 = true/checked`);
      console.log(`So enabled=${r.min_30day_trades_enabled} means: ${r.min_30day_trades_enabled === 1 ? 'CHECKED ✅' : 'UNCHECKED ❌'}`);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

check();
