require('dotenv').config();
const mysql = require('mysql2/promise');

async function test() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'agpssvda',
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('✅ TESTING VALUE RESET ON UNCHECK\n');
    
    const adNo = '13900814235866066944';
    
    const [rules] = await connection.query(`
      SELECT 
        min_30day_trades_enabled,
        min_30day_trades,
        min_30day_completion_rate_enabled,
        min_30day_completion_rate,
        min_registered_days_enabled,
        min_registered_days,
        min_trade_volume_enabled,
        min_trade_volume
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    if (rules.length === 0) return;

    const rule = rules[0];
    
    console.log('📊 DATABASE STATE (After Uncheck + Save):\n');
    
    console.log('CORE CRITERIA:');
    console.log(`  min_30day_trades:`);
    console.log(`    enabled: ${rule.min_30day_trades_enabled} ${rule.min_30day_trades_enabled === 0 ? '❌' : '✅'}`);
    console.log(`    value: ${rule.min_30day_trades} ${rule.min_30day_trades === 0 ? '✅ (RESET!)' : '❌ (should be 0)'}\n`);
    
    console.log(`  min_30day_completion_rate:`);
    console.log(`    enabled: ${rule.min_30day_completion_rate_enabled} ${rule.min_30day_completion_rate_enabled === 1 ? '✅' : '❌'}`);
    console.log(`    value: ${rule.min_30day_completion_rate} ${rule.min_30day_completion_rate_enabled === 1 ? '✅' : '❌'}\n`);
    
    console.log(`  min_registered_days:`);
    console.log(`    enabled: ${rule.min_registered_days_enabled} ${rule.min_registered_days_enabled === 1 ? '✅' : '❌'}`);
    console.log(`    value: ${rule.min_registered_days} ${rule.min_registered_days_enabled === 1 ? '✅' : '❌'}\n`);
    
    console.log('ADVANCED OPTIONS:');
    console.log(`  min_trade_volume:`);
    console.log(`    enabled: ${rule.min_trade_volume_enabled} ${rule.min_trade_volume_enabled === 1 ? '✅' : '❌'}`);
    console.log(`    value: ${rule.min_trade_volume} ${rule.min_trade_volume_enabled === 1 ? '✅' : '❌'}\n`);
    
    console.log('✅ VERIFICATION:\n');
    
    if (rule.min_30day_trades_enabled === 0 && rule.min_30day_trades === 0) {
      console.log('  ✅ min_30day_trades: CORRECTLY RESET TO 0 (unchecked)');
    } else {
      console.log(`  ❌ min_30day_trades: WRONG - enabled=${rule.min_30day_trades_enabled}, value=${rule.min_30day_trades}`);
    }
    
    if (rule.min_30day_completion_rate_enabled === 1) {
      console.log('  ✅ min_30day_completion_rate: Correctly ENABLED with value');
    }
    
    if (rule.min_registered_days_enabled === 1) {
      console.log('  ✅ min_registered_days: Correctly ENABLED with value');
    }
    
    if (rule.min_trade_volume_enabled === 1) {
      console.log('  ✅ min_trade_volume: Correctly ENABLED with value');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

test();
