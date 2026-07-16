require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

const orderNo = process.argv[2];

if (!orderNo) {
  console.log('Usage: node scripts/check-order-status.js <orderNumber>');
  process.exit(1);
}

(async () => {
  try {
    console.log(`\n📋 Checking order: ${orderNo}\n`);
    
    const status = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
    
    console.log(`Success: ${status.success}`);
    console.log(`additionalKycVerify: ${status.additionalKycVerify}`);
    console.log(`  (0=not required, 1=pending, 2=verified)`);
    console.log(`\nFull response:`);
    console.log(JSON.stringify(status, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();
