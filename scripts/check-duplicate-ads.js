const mysql = require('mysql2/promise');

(async () => {
  const livePool = mysql.createPool({
    host: '198.38.81.34',
    user: 'agpssvda1_p2p_user',
    password: 'Createmy@123456',
    database: 'agpssvda1_p2p',
    connectTimeout: 30000,
  });

  const localPool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'agpssvda',
  });

  try {
    const liveConn = await livePool.getConnection();
    const localConn = await localPool.getConnection();

    console.log('🔍 Checking for duplicate ads...\n');

    // Check LIVE DB for duplicates
    const [liveDupes] = await liveConn.query(`
      SELECT ad_no, COUNT(*) as count
      FROM seller_ads
      GROUP BY ad_no
      HAVING COUNT(*) > 1
    `);

    if (liveDupes.length > 0) {
      console.log('❌ DUPLICATE ADS FOUND IN LIVE DB:');
      liveDupes.forEach(d => {
        console.log(`   Ad ${d.ad_no}: ${d.count} copies`);
      });
    } else {
      console.log('✅ NO DUPLICATES in LIVE DB');
    }

    // Check LOCAL DB for duplicates
    const [localDupes] = await localConn.query(`
      SELECT ad_no, COUNT(*) as count
      FROM seller_ads
      GROUP BY ad_no
      HAVING COUNT(*) > 1
    `);

    if (localDupes.length > 0) {
      console.log('\n❌ DUPLICATE ADS FOUND IN LOCAL DB:');
      localDupes.forEach(d => {
        console.log(`   Ad ${d.ad_no}: ${d.count} copies`);
      });
    } else {
      console.log('\n✅ NO DUPLICATES in LOCAL DB');
    }

    // Summary
    const [liveCount] = await liveConn.query('SELECT COUNT(*) as total FROM seller_ads');
    const [liveUnique] = await liveConn.query('SELECT COUNT(DISTINCT ad_no) as unique_ads FROM seller_ads');

    const [localCount] = await localConn.query('SELECT COUNT(*) as total FROM seller_ads');
    const [localUnique] = await localConn.query('SELECT COUNT(DISTINCT ad_no) as unique_ads FROM seller_ads');

    console.log('\n📊 SUMMARY:');
    console.log(`LIVE DB: ${liveCount[0].total} total rows, ${liveUnique[0].unique_ads} unique ads`);
    console.log(`LOCAL DB: ${localCount[0].total} total rows, ${localUnique[0].unique_ads} unique ads`);

    if (liveCount[0].total === liveUnique[0].unique_ads && localCount[0].total === localUnique[0].unique_ads) {
      console.log('\n✅ ALL GOOD - No duplicates detected!');
    }

    liveConn.release();
    localConn.release();
    livePool.end();
    localPool.end();
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
