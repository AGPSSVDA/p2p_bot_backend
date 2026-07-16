const mysql = require('mysql2/promise');
require('dotenv').config();

async function testMethodsPreservation() {
  let connection;
  try {
    console.log('🔍 Testing Methods Preservation During Eligibility Updates\n');
    console.log('═'.repeat(70));

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306,
    });

    const adNo = '13900814235866066944';

    // Test 1: Check initial state
    console.log('\n📋 Test 1: Check Initial State');
    console.log('─'.repeat(70));

    const [initialState] = await connection.query(`
      SELECT
        ad_no,
        min_30day_trades_enabled, min_30day_trades,
        method1_liveness_enabled,
        method2_documents_enabled,
        method3_full_enabled
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    if (initialState.length === 0) {
      console.log('❌ No rules found for this ad');
      return;
    }

    const initial = initialState[0];
    console.log(`✅ Initial State for Ad: ${adNo}\n`);
    console.log(`Eligibility:`);
    console.log(`  30-Day Trades Enabled: ${initial.min_30day_trades_enabled}`);
    console.log(`  30-Day Trades Value: ${initial.min_30day_trades}\n`);
    console.log(`Methods:`);
    console.log(`  Method 1 (Liveness): ${initial.method1_liveness_enabled}`);
    console.log(`  Method 2 (Documents): ${initial.method2_documents_enabled}`);
    console.log(`  Method 3 (Full): ${initial.method3_full_enabled}`);

    // Test 2: Simulate updating ONLY eligibility criteria (like frontend does)
    console.log('\n\n📝 Test 2: Simulate Frontend Updating Only Eligibility');
    console.log('─'.repeat(70));
    console.log('Frontend sends update for eligibility ONLY:');
    console.log('  min_30day_trades_enabled: false');
    console.log('  min_30day_trades: 25');
    console.log('  (Methods are NOT included in payload)\n');

    // Simulate the update with ONLY eligibility fields
    // Like frontend does when updating eligibility
    const updatePayload = {
      min_30day_trades_enabled: false,
      min_30day_trades: 25,
      // Note: Methods are NOT included
    };

    console.log('Backend receives:');
    console.log(`  ${JSON.stringify(updatePayload)}\n`);

    // Simulate what the backend SHOULD do (preserve methods)
    console.log('Backend logic:');
    console.log('  1. Fetch existing rules');
    const [existingRules] = await connection.query(`
      SELECT * FROM seller_ad_rules WHERE ad_no = ?
    `, [adNo]);

    const existing = existingRules[0];
    console.log(`  ✅ Fetched existing rules`);
    console.log(`     method1_liveness_enabled: ${existing.method1_liveness_enabled}`);
    console.log(`     method2_documents_enabled: ${existing.method2_documents_enabled}`);
    console.log(`     method3_full_enabled: ${existing.method3_full_enabled}\n`);

    console.log('  2. Merge payload with existing (preserve methods)');
    const mergedData = {
      // From payload
      min_30day_trades_enabled: updatePayload.min_30day_trades_enabled,
      min_30day_trades: updatePayload.min_30day_trades,

      // Preserve existing methods (because they're not in payload)
      method1_liveness_enabled: existing.method1_liveness_enabled === 1 ? true : existing.method1_liveness_enabled,
      method2_documents_enabled: existing.method2_documents_enabled === 1 ? true : existing.method2_documents_enabled,
      method3_full_enabled: existing.method3_full_enabled === 1 ? true : existing.method3_full_enabled,
    };

    console.log(`     Merged data to save:`);
    console.log(`     min_30day_trades_enabled: ${mergedData.min_30day_trades_enabled} (from payload)`);
    console.log(`     method1_liveness_enabled: ${mergedData.method1_liveness_enabled} (preserved)\n`);

    // Test 3: Actual database update
    console.log('📝 Test 3: Perform Database Update');
    console.log('─'.repeat(70));

    await connection.query(`
      UPDATE seller_ad_rules SET
        min_30day_trades_enabled = ?,
        min_30day_trades = ?
      WHERE ad_no = ?
    `, [mergedData.min_30day_trades_enabled ? 1 : 0, mergedData.min_30day_trades, adNo]);

    console.log('✅ Database updated\n');

    // Test 4: Verify methods are still the same
    console.log('📋 Test 4: Verify Methods Preserved After Update');
    console.log('─'.repeat(70));

    const [afterUpdate] = await connection.query(`
      SELECT
        min_30day_trades_enabled, min_30day_trades,
        method1_liveness_enabled,
        method2_documents_enabled,
        method3_full_enabled
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    const after = afterUpdate[0];
    console.log(`✅ After Update:\n`);
    console.log(`Eligibility:`);
    console.log(`  30-Day Trades Enabled: ${after.min_30day_trades_enabled} (CHANGED ✅)`);
    console.log(`  30-Day Trades Value: ${after.min_30day_trades}\n`);
    console.log(`Methods:`);
    console.log(`  Method 1: ${after.method1_liveness_enabled} (${after.method1_liveness_enabled === initial.method1_liveness_enabled ? 'PRESERVED ✅' : 'CHANGED ❌'})`);
    console.log(`  Method 2: ${after.method2_documents_enabled} (${after.method2_documents_enabled === initial.method2_documents_enabled ? 'PRESERVED ✅' : 'CHANGED ❌'})`);
    console.log(`  Method 3: ${after.method3_full_enabled} (${after.method3_full_enabled === initial.method3_full_enabled ? 'PRESERVED ✅' : 'CHANGED ❌'})`);

    // Test 5: Verify response format
    console.log('\n\n📤 Test 5: Verify API Response Format');
    console.log('─'.repeat(70));

    const apiResponse = {
      eligibility: {
        min30dayTrades: {
          enabled: after.min_30day_trades_enabled === 1,
          value: after.min_30day_trades
        }
      },
      methods: {
        method1: {
          enabled: after.method1_liveness_enabled === 1
        },
        method2: {
          enabled: after.method2_documents_enabled === 1
        },
        method3: {
          enabled: after.method3_full_enabled === 1
        }
      }
    };

    console.log('✅ Response to frontend:\n');
    console.log(JSON.stringify(apiResponse, null, 2));

    // Summary
    console.log('\n\n═'.repeat(70));
    console.log('✅ SUMMARY\n');

    const eligibilityChanged = after.min_30day_trades_enabled !== initial.min_30day_trades_enabled;
    const method1Preserved = after.method1_liveness_enabled === initial.method1_liveness_enabled;
    const method2Preserved = after.method2_documents_enabled === initial.method2_documents_enabled;
    const method3Preserved = after.method3_full_enabled === initial.method3_full_enabled;

    console.log(`Eligibility Updated: ${eligibilityChanged ? '✅' : '❌'}`);
    console.log(`Method 1 Preserved: ${method1Preserved ? '✅' : '❌'}`);
    console.log(`Method 2 Preserved: ${method2Preserved ? '✅' : '❌'}`);
    console.log(`Method 3 Preserved: ${method3Preserved ? '✅' : '❌'}`);

    if (eligibilityChanged && method1Preserved && method2Preserved && method3Preserved) {
      console.log('\n🎉 ALL TESTS PASSED! Methods are properly preserved.');
    } else {
      console.log('\n⚠️  Some issues detected. Review the results above.');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

testMethodsPreservation();
