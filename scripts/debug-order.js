require('dotenv').config();
const sellerBinanceService = require('../src/seller/services/sellerBinanceService');

(async () => {
  try {
    const orderNo = '22909004590982631424';
    console.log(`\nChecking order: ${orderNo}\n`);

    const response = await sellerBinanceService.getOrderStatusByOrderNumber(orderNo);
    
    console.log(`Full response:`, JSON.stringify(response, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    process.exit(1);
  }
})();
