const mysql = require('mysql2/promise');

(async () => {
  const livePool = mysql.createPool({
    host: '198.38.81.34',
    user: 'agpssvda1_p2p_user',
    password: 'Createmy@123456',
    database: 'agpssvda1_p2p',
    connectTimeout: 30000,
  });

  const liveConn = await livePool.getConnection();
  const [ads] = await liveConn.query('SELECT ad_no, ad_status, is_active FROM seller_ads ORDER BY ad_no');

  console.log('All ads in LIVE DB:\n');
  ads.forEach(a => console.log(`  ${a.ad_no}: ad_status=${a.ad_status} (1=Online, 3=Offline), is_active=${a.is_active}`));

  console.log(`\nTotal: ${ads.length} ads`);
  console.log(`Online (status=1): ${ads.filter(a => a.ad_status === 1).length}`);
  console.log(`Offline (status=3): ${ads.filter(a => a.ad_status === 3).length}`);

  liveConn.release();
  livePool.end();
})();
