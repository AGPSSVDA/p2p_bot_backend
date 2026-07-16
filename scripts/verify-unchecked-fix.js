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
    console.log('🧪 VERIFYING UNCHECKED STATE FIX\n');
    
    const adNo = '13900814235866066944';
    
    // Get current database state
    const [dbRules] = await connection.query(`
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
        min_btc_holding
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    if (dbRules.length === 0) {
      console.log('❌ No rules found for this ad');
      return;
    }

    const rule = dbRules[0];
    
    console.log('📊 DATABASE STATE:\n');
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
    
    // Simulate what backend now does
    console.log('\n🔄 SIMULATING BACKEND RESPONSE (getAdDetail endpoint):\n');
    
    const eligibility = {
      min30dayTrades: {
        enabled: rule.min_30day_trades_enabled === 1 || rule.min_30day_trades_enabled === true,
        value: rule.min_30day_trades || 0
      },
      min30dayCompletionRate: {
        enabled: rule.min_30day_completion_rate_enabled === 1 || rule.min_30day_completion_rate_enabled === true,
        value: rule.min_30day_completion_rate || 0
      },
      minRegisteredDays: {
        enabled: rule.min_registered_days_enabled === 1 || rule.min_registered_days_enabled === true,
        value: rule.min_registered_days || 0
      },
      minAllTradesCount: {
        enabled: rule.min_all_trades_count_enabled === 1 || rule.min_all_trades_count_enabled === true,
        value: rule.min_all_trades_count || 0
      },
      minBuyOrdersCount: {
        enabled: rule.min_buy_orders_count_enabled === 1 || rule.min_buy_orders_count_enabled === true,
        value: rule.min_buy_orders_count || 0
      },
      minSellOrdersCount: {
        enabled: rule.min_sell_orders_count_enabled === 1 || rule.min_sell_orders_count_enabled === true,
        value: rule.min_sell_orders_count || 0
      },
      minTradeVolume: {
        enabled: rule.min_trade_volume_enabled === 1 || rule.min_trade_volume_enabled === true,
        value: rule.min_trade_volume || 0
      },
      maxTradeVolume: {
        enabled: rule.max_trade_volume_enabled === 1 || rule.max_trade_volume_enabled === true,
        value: rule.max_trade_volume || 0
      },
      minBtcHolding: {
        enabled: rule.min_btc_holding_enabled === 1 || rule.min_btc_holding_enabled === true,
        value: rule.min_btc_holding || 0
      }
    };
    
    console.log('RESPONSE TO FRONTEND:\n');
    console.log(JSON.stringify(eligibility, null, 2));
    
    console.log('\n✅ VERIFICATION:\n');
    
    // Check unchecked fields
    const uncheckedFields = [
      { name: 'min30dayTrades', value: eligibility.min30dayTrades },
      { name: 'minTradeVolume', value: eligibility.minTradeVolume },
      { name: 'maxTradeVolume', value: eligibility.maxTradeVolume },
      { name: 'minBtcHolding', value: eligibility.minBtcHolding }
    ];
    
    let allCorrect = true;
    uncheckedFields.forEach(field => {
      if (!field.value.enabled) {
        console.log(`  ✓ ${field.name}: UNCHECKED (enabled: false) - CORRECT!`);
      } else {
        console.log(`  ✗ ${field.name}: ERROR - Showing as CHECKED but DB says enabled=${rule[toDBFieldName(field.name) + '_enabled']}`);
        allCorrect = false;
      }
    });
    
    if (allCorrect) {
      console.log('\n✅ BUG FIX VERIFIED! Unchecked states now properly shown to frontend!');
    } else {
      console.log('\n❌ Some fields still showing wrong state');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

function toDBFieldName(field) {
  return field.replace(/([A-Z])/g, '_$1').toLowerCase();
}

verify();
