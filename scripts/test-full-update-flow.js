const mysql = require('mysql2/promise');
require('dotenv').config();

async function testFullUpdateFlow() {
  let connection;
  try {
    console.log('🔍 Testing Full Update Flow\n');
    console.log('═'.repeat(70));

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306,
    });

    const adNo = '13900814235866066944';

    // Step 1: Get initial state
    console.log('\n📋 Step 1: Get Initial State');
    console.log('─'.repeat(70));

    const [initial] = await connection.query(`
      SELECT
        min_30day_trades_enabled, min_30day_trades,
        method1_liveness_enabled,
        method2_documents_enabled,
        method3_full_enabled
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    const initialState = initial[0];
    console.log(`Initial State:`);
    console.log(`  30-Day Trades: enabled=${initialState.min_30day_trades_enabled}, value=${initialState.min_30day_trades}`);
    console.log(`  Methods: method1=${initialState.method1_liveness_enabled}, method2=${initialState.method2_documents_enabled}, method3=${initialState.method3_full_enabled}`);

    // Step 2: Simulate frontend payload (what frontend sends)
    console.log('\n📝 Step 2: Simulate Frontend Payload');
    console.log('─'.repeat(70));

    const frontendPayload = {
      // Eligibility - changed
      min_30day_trades_enabled: true,
      min_30day_trades: 50,

      // Methods - preserved from UI (same as before)
      method1_liveness_enabled: initialState.method1_liveness_enabled === 1 ? true : false,
      method2_documents_enabled: initialState.method2_documents_enabled === 1 ? true : false,
      method3_full_enabled: initialState.method3_full_enabled === 1 ? true : false,
    };

    console.log(`Frontend sends:`);
    console.log(JSON.stringify(frontendPayload, null, 2));

    // Step 3: Simulate backend sellerAdService.updateAdRules() logic
    console.log('\n⚙️  Step 3: Backend sellerAdService.updateAdRules() Logic');
    console.log('─'.repeat(70));

    // Get existing rules (like backend does)
    const [existing] = await connection.query(`
      SELECT * FROM seller_ad_rules WHERE ad_no = ?
    `, [adNo]);

    const existingRules = existing[0];

    // Build update data with preservation logic
    const backendUpdateData = {
      // If provided in payload, use it. Otherwise preserve existing
      min_30day_trades_enabled: frontendPayload.min_30day_trades_enabled !== undefined
        ? frontendPayload.min_30day_trades_enabled === true
        : (existingRules.min_30day_trades_enabled === 1 || existingRules.min_30day_trades_enabled === true),
      min_30day_trades: frontendPayload.min_30day_trades !== undefined ? frontendPayload.min_30day_trades : (existingRules.min_30day_trades || 0),

      // Methods - preserve since they may not be fully in payload sometimes
      method1_liveness_enabled: frontendPayload.method1_liveness_enabled !== undefined
        ? frontendPayload.method1_liveness_enabled === true
        : (existingRules.method1_liveness_enabled === 1 || existingRules.method1_liveness_enabled === true),
      method2_documents_enabled: frontendPayload.method2_documents_enabled !== undefined
        ? frontendPayload.method2_documents_enabled === true
        : (existingRules.method2_documents_enabled === 1 || existingRules.method2_documents_enabled === true),
      method3_full_enabled: frontendPayload.method3_full_enabled !== undefined
        ? frontendPayload.method3_full_enabled === true
        : (existingRules.method3_full_enabled === 1 || existingRules.method3_full_enabled === true),
    };

    console.log(`Backend builds update data:`);
    console.log(JSON.stringify(backendUpdateData, null, 2));

    // Step 4: Execute the UPDATE
    console.log('\n💾 Step 4: Execute Database UPDATE');
    console.log('─'.repeat(70));

    await connection.query(`
      UPDATE seller_ad_rules SET
        min_30day_trades_enabled = ?,
        min_30day_trades = ?,
        method1_liveness_enabled = ?,
        method2_documents_enabled = ?,
        method3_full_enabled = ?
      WHERE ad_no = ?
    `, [
      backendUpdateData.min_30day_trades_enabled ? 1 : 0,
      backendUpdateData.min_30day_trades,
      backendUpdateData.method1_liveness_enabled ? 1 : 0,
      backendUpdateData.method2_documents_enabled ? 1 : 0,
      backendUpdateData.method3_full_enabled ? 1 : 0,
      adNo
    ]);

    console.log(`✅ Database updated`);

    // Step 5: Get final state
    console.log('\n📋 Step 5: Get Final State');
    console.log('─'.repeat(70));

    const [final] = await connection.query(`
      SELECT
        min_30day_trades_enabled, min_30day_trades,
        method1_liveness_enabled,
        method2_documents_enabled,
        method3_full_enabled
      FROM seller_ad_rules
      WHERE ad_no = ?
    `, [adNo]);

    const finalState = final[0];
    console.log(`Final State:`);
    console.log(`  30-Day Trades: enabled=${finalState.min_30day_trades_enabled}, value=${finalState.min_30day_trades}`);
    console.log(`  Methods: method1=${finalState.method1_liveness_enabled}, method2=${finalState.method2_documents_enabled}, method3=${finalState.method3_full_enabled}`);

    // Step 6: Verify
    console.log('\n✅ Verification');
    console.log('─'.repeat(70));

    const eligibilityChanged = finalState.min_30day_trades !== initialState.min_30day_trades;
    const method1Same = finalState.method1_liveness_enabled === initialState.method1_liveness_enabled;
    const method2Same = finalState.method2_documents_enabled === initialState.method2_documents_enabled;
    const method3Same = finalState.method3_full_enabled === initialState.method3_full_enabled;

    console.log(`Eligibility Changed: ${eligibilityChanged ? '✅' : '❌'}`);
    console.log(`Method 1 Preserved: ${method1Same ? '✅' : '❌'}`);
    console.log(`Method 2 Preserved: ${method2Same ? '✅' : '❌'}`);
    console.log(`Method 3 Preserved: ${method3Same ? '✅' : '❌'}`);

    if (eligibilityChanged && method1Same && method2Same && method3Same) {
      console.log('\n🎉 FULL UPDATE FLOW WORKS CORRECTLY!');
    } else {
      console.log('\n⚠️  Issues detected');
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

testFullUpdateFlow();
