require('dotenv').config();
const axios = require('axios');

async function test() {
  try {
    console.log('🧪 Testing Unchecked State Persistence\n');
    
    const adNo = '13900814235866066944';
    
    // Call getAdDetail endpoint
    console.log(`📡 Fetching ad details from backend...\n`);
    const response = await axios.get(`http://localhost:5000/api/seller/ads/${adNo}`);
    
    if (response.data.success) {
      const rules = response.data.data.rules.eligibility;
      
      console.log('✅ RESPONSE RECEIVED:\n');
      console.log('CORE CRITERIA:');
      console.log(`  min30dayTrades:`);
      console.log(`    enabled: ${rules.min30dayTrades.enabled} ${rules.min30dayTrades.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.min30dayTrades.value}\n`);
      
      console.log(`  min30dayCompletionRate:`);
      console.log(`    enabled: ${rules.min30dayCompletionRate.enabled} ${rules.min30dayCompletionRate.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.min30dayCompletionRate.value}\n`);
      
      console.log(`  minRegisteredDays:`);
      console.log(`    enabled: ${rules.minRegisteredDays.enabled} ${rules.minRegisteredDays.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minRegisteredDays.value}\n`);
      
      console.log(`  minAllTradesCount:`);
      console.log(`    enabled: ${rules.minAllTradesCount.enabled} ${rules.minAllTradesCount.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minAllTradesCount.value}\n`);
      
      console.log(`  minBuyOrdersCount:`);
      console.log(`    enabled: ${rules.minBuyOrdersCount.enabled} ${rules.minBuyOrdersCount.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minBuyOrdersCount.value}\n`);
      
      console.log(`  minSellOrdersCount:`);
      console.log(`    enabled: ${rules.minSellOrdersCount.enabled} ${rules.minSellOrdersCount.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minSellOrdersCount.value}\n`);
      
      console.log('ADVANCED OPTIONS:');
      console.log(`  minTradeVolume:`);
      console.log(`    enabled: ${rules.minTradeVolume.enabled} ${rules.minTradeVolume.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minTradeVolume.value}\n`);
      
      console.log(`  maxTradeVolume:`);
      console.log(`    enabled: ${rules.maxTradeVolume.enabled} ${rules.maxTradeVolume.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.maxTradeVolume.value}\n`);
      
      console.log(`  minBtcHolding:`);
      console.log(`    enabled: ${rules.minBtcHolding.enabled} ${rules.minBtcHolding.enabled ? '✓' : '❌'}`);
      console.log(`    value: ${rules.minBtcHolding.value}\n`);
      
      // Verify unchecked states
      console.log('✅ VERIFICATION:\n');
      const uncheckedFields = [
        { name: 'min30dayTrades', field: rules.min30dayTrades },
        { name: 'minTradeVolume', field: rules.minTradeVolume },
        { name: 'maxTradeVolume', field: rules.maxTradeVolume },
        { name: 'minBtcHolding', field: rules.minBtcHolding }
      ];
      
      uncheckedFields.forEach(item => {
        if (!item.field.enabled) {
          console.log(`  ✓ ${item.name}: Correctly showing as UNCHECKED (enabled=false)`);
        } else {
          console.log(`  ✗ ${item.name}: ERROR - Showing as CHECKED but should be unchecked!`);
        }
      });
      
    } else {
      console.log('❌ API returned error:', response.data.error);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

test();
