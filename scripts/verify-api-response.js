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
    console.log('🧪 SIMULATING API RESPONSE\n');
    
    const adNo = '13900814235866066944';
    
    const [adRules] = await connection.query(`
      SELECT * FROM seller_ad_rules WHERE ad_no = ?
    `, [adNo]);

    if (adRules.length === 0) {
      console.log('No rules found');
      return;
    }

    const ad = { rules: adRules[0] };
    
    // This is what getAds endpoint returns
    const eligibility = {
      min30dayTrades: {
        enabled: ad.rules.min_30day_trades_enabled === 1 || ad.rules.min_30day_trades_enabled === true,
        value: ad.rules.min_30day_trades || 0
      },
      min30dayCompletionRate: {
        enabled: ad.rules.min_30day_completion_rate_enabled === 1 || ad.rules.min_30day_completion_rate_enabled === true,
        value: ad.rules.min_30day_completion_rate || 0
      },
      minRegisteredDays: {
        enabled: ad.rules.min_registered_days_enabled === 1 || ad.rules.min_registered_days_enabled === true,
        value: ad.rules.min_registered_days || 0
      },
      minAllTradesCount: {
        enabled: ad.rules.min_all_trades_count_enabled === 1 || ad.rules.min_all_trades_count_enabled === true,
        value: ad.rules.min_all_trades_count || 0
      },
      minBuyOrdersCount: {
        enabled: ad.rules.min_buy_orders_count_enabled === 1 || ad.rules.min_buy_orders_count_enabled === true,
        value: ad.rules.min_buy_orders_count || 0
      },
      minSellOrdersCount: {
        enabled: ad.rules.min_sell_orders_count_enabled === 1 || ad.rules.min_sell_orders_count_enabled === true,
        value: ad.rules.min_sell_orders_count || 0
      },
      minTradeVolume: {
        enabled: ad.rules.min_trade_volume_enabled === 1 || ad.rules.min_trade_volume_enabled === true,
        value: ad.rules.min_trade_volume || 0
      },
      maxTradeVolume: {
        enabled: ad.rules.max_trade_volume_enabled === 1 || ad.rules.max_trade_volume_enabled === true,
        value: ad.rules.max_trade_volume || 0
      },
      minBtcHolding: {
        enabled: ad.rules.min_btc_holding_enabled === 1 || ad.rules.min_btc_holding_enabled === true,
        value: ad.rules.min_btc_holding || 0
      }
    };
    
    console.log('API Response (GET /api/seller/ads):\n');
    console.log(JSON.stringify(eligibility, null, 2));
    
    console.log('\n✅ VERIFICATION:\n');
    
    const issues = [];
    if (eligibility.min30dayTrades.enabled === false && eligibility.min30dayTrades.value !== 0) {
      issues.push(`❌ min30dayTrades: unchecked but value=${eligibility.min30dayTrades.value} (should be 0)`);
    } else if (eligibility.min30dayTrades.enabled === false && eligibility.min30dayTrades.value === 0) {
      console.log('✅ min30dayTrades: Correctly unchecked with value=0');
    }
    
    if (eligibility.maxTradeVolume.enabled === false && eligibility.maxTradeVolume.value !== 0) {
      issues.push(`❌ maxTradeVolume: unchecked but value=${eligibility.maxTradeVolume.value} (should be 0)`);
    } else if (eligibility.maxTradeVolume.enabled === false && eligibility.maxTradeVolume.value === 0) {
      console.log('✅ maxTradeVolume: Correctly unchecked with value=0');
    }
    
    if (eligibility.minBtcHolding.enabled === false && eligibility.minBtcHolding.value !== 0) {
      issues.push(`❌ minBtcHolding: unchecked but value=${eligibility.minBtcHolding.value} (should be 0)`);
    } else if (eligibility.minBtcHolding.enabled === false && eligibility.minBtcHolding.value === 0) {
      console.log('✅ minBtcHolding: Correctly unchecked with value=0');
    }
    
    if (eligibility.minTradeVolume.enabled === true) {
      console.log(`✅ minTradeVolume: Correctly enabled with value=${eligibility.minTradeVolume.value}`);
    }
    
    if (issues.length === 0) {
      console.log('\n✅ ALL VALUES CORRECT!');
    } else {
      console.log('\n' + issues.join('\n'));
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

verify();
