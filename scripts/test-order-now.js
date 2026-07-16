require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const orderNo = '22909004590982631424';

(async () => {
  try {
    console.log(`\n📋 Testing order: ${orderNo}\n`);

    // Step 1: Check current status
    console.log(`Step 1: Checking current status...`);
    const status1 = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
    console.log(`  additionalKycVerify: ${status1.additionalKycVerify}\n`);

    if (status1.additionalKycVerify === 1) {
      console.log(`Step 2: Calling verifyAdditionalKyc()...`);
      const result = await sellerBinanceService.verifyAdditionalKyc(orderNo);
      console.log(`  Result:`, result, `\n`);

      console.log(`Step 3: Waiting 2 seconds then re-checking...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const status2 = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
      console.log(`  additionalKycVerify: ${status2.additionalKycVerify}\n`);

      if (status2.additionalKycVerify === 2) {
        console.log(`✅ SUCCESS! Status changed 1 → 2\n`);
      } else {
        console.log(`⚠️  Status still ${status2.additionalKycVerify}\n`);
      }
    } else if (status1.additionalKycVerify === 2) {
      console.log(`✅ Status already 2 (verified)\n`);
    }

    process.exit(0);
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    process.exit(1);
  }
})();
