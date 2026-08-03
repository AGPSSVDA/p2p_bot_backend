const mysql = require('mysql2/promise');

(async () => {
  const localPool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'agpssvda',
  });

  const livePool = mysql.createPool({
    host: '198.38.81.34',
    user: 'agpssvda1_p2p_user',
    password: 'Createmy@123456',
    database: 'agpssvda1_p2p',
    connectTimeout: 30000,
  });

  try {
    const localConn = await localPool.getConnection();
    const liveConn = await livePool.getConnection();

    console.log('✅ Connected to both databases\n');

    // Get all ads from LOCAL
    const [localAds] = await localConn.query('SELECT * FROM seller_ads');
    const [liveAds] = await liveConn.query('SELECT ad_no FROM seller_ads');

    const liveAdNos = new Set(liveAds.map(a => a.ad_no));
    const missingAds = localAds.filter(a => !liveAdNos.has(a.ad_no));

    console.log(`📊 Comparing databases:`);
    console.log(`   LOCAL: ${localAds.length} ads`);
    console.log(`   LIVE:  ${liveAds.length} ads`);
    console.log(`   MISSING: ${missingAds.length} ads\n`);

    if (missingAds.length === 0) {
      console.log('✅ All ads already synced!');
      localConn.release();
      liveConn.release();
      localPool.end();
      livePool.end();
      return;
    }

    // Sync each missing ad
    for (const ad of missingAds) {
      const insertQuery = `
        INSERT INTO seller_ads (
          seller_id, ad_no, ad_name, ad_status, is_active, classify, trade_type, asset, fiat_unit,
          fiat_symbol, price_rate, price_type, price_floating_ratio, commission_rate, min_order_amount,
          max_order_amount, surplus_amount, init_amount, buyer_kyc_required, buyer_reg_days_limit,
          buyer_btc_position_limit, user_buy_trade_count_min, user_buy_trade_count_max,
          user_sell_trade_count_min, user_sell_trade_count_max, user_all_trade_count_min,
          user_all_trade_count_max, user_trade_complete_count_min, user_trade_complete_rate_min,
          user_trade_volume_min, user_trade_volume_max, pay_time_limit, remarks, auto_reply_msg,
          offline_reason, asset_scale, fiat_scale, price_scale, binance_create_time, binance_update_time,
          total_orders, completed_orders, failed_orders, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at = NOW()
      `;

      await liveConn.query(insertQuery, [
        ad.seller_id, ad.ad_no, ad.ad_name, ad.ad_status, ad.is_active, ad.classify, ad.trade_type,
        ad.asset, ad.fiat_unit, ad.fiat_symbol, ad.price_rate, ad.price_type, ad.price_floating_ratio,
        ad.commission_rate, ad.min_order_amount, ad.max_order_amount, ad.surplus_amount, ad.init_amount,
        ad.buyer_kyc_required, ad.buyer_reg_days_limit, ad.buyer_btc_position_limit, ad.user_buy_trade_count_min,
        ad.user_buy_trade_count_max, ad.user_sell_trade_count_min, ad.user_sell_trade_count_max,
        ad.user_all_trade_count_min, ad.user_all_trade_count_max, ad.user_trade_complete_count_min,
        ad.user_trade_complete_rate_min, ad.user_trade_volume_min, ad.user_trade_volume_max,
        ad.pay_time_limit, ad.remarks, ad.auto_reply_msg, ad.offline_reason, ad.asset_scale,
        ad.fiat_scale, ad.price_scale, ad.binance_create_time, ad.binance_update_time,
        ad.total_orders, ad.completed_orders, ad.failed_orders, ad.created_at, ad.updated_at
      ]);

      console.log(`✅ Synced: ${ad.ad_no}`);
    }

    console.log(`\n✅ Successfully synced ${missingAds.length} ads to LIVE DB`);

    localConn.release();
    liveConn.release();
    localPool.end();
    livePool.end();
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
