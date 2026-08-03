const mysql = require('mysql2/promise');

(async () => {
  const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'agpssvda',
  });
  const conn = await pool.getConnection();

  try {
    // Get all ads without rules
    const [ads] = await conn.query(`
      SELECT a.ad_no, a.seller_id
      FROM seller_ads a
      LEFT JOIN seller_ad_rules r ON a.ad_no = r.ad_no
      WHERE r.ad_no IS NULL
    `);

    if (ads.length === 0) {
      console.log('✅ All ads already have rules');
      conn.release();
      pool.end();
      return;
    }

    console.log(`📝 Creating rules for ${ads.length} ads without rules...`);

    // Create default rule for each ad
    for (const ad of ads) {
      await conn.query(`
        INSERT INTO seller_ad_rules (
          seller_id, ad_no,
          method1_liveness_enabled,
          method2_documents_enabled,
          method3_full_enabled,
          created_at, updated_at
        ) VALUES (?, ?, 1, 0, 0, NOW(), NOW())
      `, [ad.seller_id, ad.ad_no]);

      console.log(`✅ Created rule for ad: ${ad.ad_no}`);
    }

    console.log(`\n✅ Successfully created ${ads.length} rules`);
    conn.release();
    pool.end();
  } catch (e) {
    console.error('❌ Error:', e.message);
    conn.release();
    pool.end();
    process.exit(1);
  }
})();
