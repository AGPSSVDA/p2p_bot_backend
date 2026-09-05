const logger = require('../../utils/logger');
const { getSellerAds } = require('../../services/sellerBinanceService');
const sellerOrderDbService = require('../services/sellerOrderDbService');
const { getSellerIdFromRequest } = require('../utils/sellerUtils');

/**
 * ===== SELLER SYNC CONTROLLER =====
 * Sync seller ads from Binance to database
 */
class SellerSyncController {

  /**
   * POST /api/seller/sync/ads
   * Fetch seller's ads from Binance and sync to database
   */
  async syncAdsFromBinance(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      console.log('🔵 [SELLER SYNC] Checking SELLER_ID:', sellerId);
      logger.info('🔵 [SELLER SYNC] Checking SELLER_ID', { sellerId });

      if (!sellerId) {
        console.log('❌ [SELLER SYNC] SELLER_ID not configured in .env');
        return res.status(400).json({
          success: false,
          error: 'SELLER_ID not configured in .env'
        });
      }

      console.log('✅ [SELLER SYNC] SELLER_ID found:', sellerId);
      logger.info('✅ [SELLER SYNC] SELLER_ID found', { sellerId });
      console.log('🔄 [SELLER SYNC] Starting ad sync from Binance...');
      logger.info('🔄 [SELLER SYNC] Starting ad sync from Binance', { sellerId });

      // 1. Fetch ads from Binance using seller credentials. Use a high `rows` so we
      // get ALL ads (not just the first 20) — otherwise ads beyond page 1 never get
      // their status refreshed and show up stale (e.g. "live" when actually offline).
      console.log('📡 [SELLER SYNC] Calling getSellerAds()...');
      const binanceAds = await getSellerAds(1, 100);
      console.log('✅ [SELLER SYNC] getSellerAds() returned', binanceAds.length, 'ads');
      logger.info(`✅ [SELLER SYNC] Fetched ${binanceAds.length} ads from Binance`, { sellerId, count: binanceAds.length });

      if (binanceAds.length === 0) {
        console.log('⚠️  [SELLER SYNC] No ads found on Binance for seller:', sellerId);
        logger.warn('[SELLER SYNC] No ads found on Binance', { sellerId });
        return res.status(200).json({
          success: true,
          data: {
            synced: 0,
            total: 0,
            message: 'No ads found on Binance'
          }
        });
      }

      console.log('🔄 [SELLER SYNC] Processing', binanceAds.length, 'ads from Binance...');
      console.log('📋 [SELLER SYNC] Ads received:', binanceAds.map(a => ({ advNo: a.advNo, asset: a.asset, tradeType: a.tradeType })));

      // 2. Sync each ad to database
      let syncedCount = 0;
      const syncedAds = [];
      let skippedCount = 0;

      for (const binanceAd of binanceAds) {
        try {
          console.log(`\n📌 [SELLER SYNC] Processing ad:`, binanceAd.advNo);
          console.log(`   - Asset: ${binanceAd.asset}, TradeType: ${binanceAd.tradeType}, Price: ${binanceAd.price}`);

          // Sync SELL ads (where seller is selling crypto to buyers)
          // From Binance perspective: tradeType: "SELL" = seller's ads
          if (binanceAd.tradeType !== 'SELL' && binanceAd.tradeType !== 'sell') {
            console.log(`   ⏭️  Skipping non-SELL ad (tradeType: ${binanceAd.tradeType})`);
            logger.debug(`[SELLER SYNC] Skipping non-SELL ad: ${binanceAd.advNo}`, { tradeType: binanceAd.tradeType });
            skippedCount++;
            continue;
          }

          console.log(`   💾 Saving ad to database for seller: ${sellerId}...`);
          await sellerOrderDbService.upsertAd(sellerId, binanceAd.advNo, binanceAd);

          // Save trade methods
          if (binanceAd.tradeMethods && binanceAd.tradeMethods.length > 0) {
            console.log(`   💳 Saving ${binanceAd.tradeMethods.length} trade methods...`);
            // Also build a map of commissionRates from tradeMethodCommissionRateVoList if available
            const commissionMap = {};
            if (binanceAd.tradeMethodCommissionRateVoList && binanceAd.tradeMethodCommissionRateVoList.length > 0) {
              binanceAd.tradeMethodCommissionRateVoList.forEach(cr => {
                commissionMap[cr.tradeMethodIdentifier] = parseFloat(cr.commissionRate) || 0;
              });
            }

            for (const method of binanceAd.tradeMethods) {
              // Get commission rate from method or from the map
              const commission = method.commissionRate
                ? parseFloat(method.commissionRate)
                : (commissionMap[method.identifier] || 0);

              // Map Binance field names to DB fields
              const methodData = {
                payId: method.payId,
                payType: method.payType,
                identifier: method.identifier,
                tradeMethodName: method.tradeMethodName,
                iconUrl: method.iconUrl || method.iconUrlColor,
                iconUrlColor: method.iconUrlColor,
                commissionRate: commission
              };
              await sellerOrderDbService.upsertAdTradeMethod(sellerId, binanceAd.advNo, methodData);
            }
          }

          syncedCount++;
          syncedAds.push({
            advNo: binanceAd.advNo,
            asset: binanceAd.asset,
            fiat: binanceAd.fiat,
            price: binanceAd.price,
            minAmount: binanceAd.minSingleTransAmount,
            maxAmount: binanceAd.maxSingleTransAmount
          });

          console.log(`   ✅ Successfully synced ad: ${binanceAd.advNo}`);
          logger.info(`✅ [SELLER SYNC] Synced ad: ${binanceAd.advNo}`, { sellerId });
        } catch (adError) {
          console.log(`   ❌ Failed to sync ad ${binanceAd.advNo}:`, adError.message);
          logger.error(`[SELLER SYNC] Failed to sync ad ${binanceAd.advNo}`, { error: adError.message, stack: adError.stack });
        }
      }

      // Close any ad that is in our DB but NO LONGER in Binance's list — it was
      // deleted/closed on Binance, so it must not keep showing as live. Mark such
      // ads ad_status=4 (Closed). Only touch SELL ads we actually got a list for.
      let closedCount = 0;
      try {
        const liveAdNos = binanceAds
          .filter(a => a.tradeType === 'SELL' || a.tradeType === 'sell')
          .map(a => a.advNo);
        if (liveAdNos.length > 0) {
          closedCount = await sellerOrderDbService.closeAdsNotIn(sellerId, liveAdNos);
          if (closedCount > 0) console.log(`🧹 [SELLER SYNC] Closed ${closedCount} ad(s) no longer on Binance`);
        }
      } catch (closeErr) {
        logger.warn(`[SELLER SYNC] closeAdsNotIn failed: ${closeErr.message}`);
      }

      console.log(`\n🎉 [SELLER SYNC] Sync completed: ${syncedCount} synced, ${skippedCount} skipped, ${closedCount} closed, ${binanceAds.length} total`);
      logger.info(`✅ [SELLER SYNC] Sync completed: ${syncedCount}/${binanceAds.length} ads synced`, { sellerId, synced: syncedCount, skipped: skippedCount, closed: closedCount });

      console.log('📤 [SELLER SYNC] Sending response with', syncedAds.length, 'ads');
      res.status(200).json({
        success: true,
        data: {
          synced: syncedCount,
          total: binanceAds.length,
          ads: syncedAds,
          message: `Successfully synced ${syncedCount} ads`
        }
      });

    } catch (error) {
      // Surface Binance's real error code, not the generic axios "400" string.
      const binanceCode = error.response?.data?.code;
      const binanceMsg = error.response?.data?.msg;

      let friendly = error.message || 'Failed to sync ads';
      if (binanceCode === -2015) {
        friendly =
          'Binance rejected the API key (-2015). Check the SELLER API key on Binance: ' +
          'is it active/not expired, does its IP whitelist include this server\'s IP, ' +
          'and is the C2C/P2P permission enabled?';
      } else if (binanceCode) {
        friendly = `Binance error ${binanceCode}: ${binanceMsg || 'unknown'}`;
      }

      console.error('❌ [SELLER SYNC] Error:', friendly);
      console.error('📍 [SELLER SYNC] Binance code/msg:', binanceCode, binanceMsg);
      logger.error(`❌ [SELLER SYNC] Sync error: ${friendly}`, {
        binanceCode,
        binanceMsg,
        message: error.message,
      });

      res.status(binanceCode === -2015 ? 502 : 500).json({
        success: false,
        error: friendly,
        binanceCode: binanceCode || null,
      });
    }
  }

  /**
   * GET /api/seller/sync/status
   * Check sync status and Binance API availability
   */
  async getSyncStatus(req, res) {
    try {
      const sellerId = getSellerIdFromRequest(req);
      console.log('🔵 [SELLER STATUS] Checking sync status for seller:', sellerId);
      logger.info('[SELLER STATUS] Checking sync status', { sellerId });

      if (!sellerId) {
        console.log('❌ [SELLER STATUS] SELLER_ID not configured');
        return res.status(400).json({
          success: false,
          error: 'SELLER_ID not configured in .env'
        });
      }

      console.log('📡 [SELLER STATUS] Testing Binance API connection...');

      // Try fetching ads to check if Binance seller API is working
      const testAds = await getSellerAds();

      console.log(`✅ [SELLER STATUS] Binance API is working! Found ${testAds.length} ads`);
      res.status(200).json({
        success: true,
        data: {
          binanceConnected: true,
          adCount: testAds.length,
          lastSync: new Date(),
          message: 'Binance API is connected'
        }
      });

    } catch (error) {
      console.error('❌ [SELLER STATUS] Binance API error:', error.message);
      logger.error(`❌ [SELLER STATUS] Sync status error: ${error.message}`, { error });
      res.status(200).json({
        success: false,
        data: {
          binanceConnected: false,
          adCount: 0,
          error: error.message || 'Cannot connect to Binance API',
          message: 'Make sure your Binance API key has C2C permissions'
        }
      });
    }
  }
}

module.exports = new SellerSyncController();
