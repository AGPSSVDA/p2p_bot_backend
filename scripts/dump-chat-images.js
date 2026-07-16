/**
 * DUMP BINANCE CHAT MESSAGES + IMAGES (READ-ONLY)
 *
 * Prints the COMPLETE raw chat response for an order so we can see exactly what
 * Binance returns for buyer-uploaded images (Aadhaar/PAN) — full JSON, plus a
 * focused view of just the image messages and their URLs.
 *
 * Usage:
 *   node scripts/dump-chat-images.js <orderNumber>
 *   node scripts/dump-chat-images.js            (auto-picks recent orders that have images)
 */

const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../src/config/sellerBinanceConfig');

const orderArg = process.argv[2];

function bsq(p = {}) {
  const t = Date.now();
  const a = { ...p, timestamp: t };
  const q = Object.entries(a)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${q}&signature=${crypto.createHmac('sha256', cfg.secretKey).update(q).digest('hex')}`;
}

const h = {
  'X-MBX-APIKEY': cfg.apiKey,
  'Content-Type': 'application/json',
  clientType: 'PC',
};

async function getRawChat(orderNo) {
  const res = await axios.get(
    'https://api.binance.com/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination?' +
      bsq({ orderNo, page: 1, rows: 50, sort: 'desc' }),
    { headers: h, timeout: 15000 }
  );
  return res.data;
}

async function listRecentOrders() {
  const res = await axios.post(
    'https://api.binance.com/sapi/v1/c2c/orderMatch/listOrders?' + bsq({}),
    { orderStatusList: [1, 2, 3, 4], tradeType: 'SELL', page: 1, rows: 20 },
    { headers: h, timeout: 15000 }
  );
  const d = res.data?.data || res.data;
  return Array.isArray(d) ? d : d?.orderList || [];
}

async function dumpOrder(orderNo) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  CHAT DUMP — order ${orderNo}`);
  console.log(`${'='.repeat(70)}\n`);

  const raw = await getRawChat(orderNo);
  const data = raw?.data || raw;
  const msgs = Array.isArray(data) ? data : data?.list || data?.data || [];

  console.log(`--- 1) FULL RAW CHAT RESPONSE (${msgs.length} messages) ---\n`);
  console.log(JSON.stringify(raw, null, 2));

  const images = msgs.filter(m => m?.type === 'image');
  const buyerImages = images.filter(m => m.self !== true);

  console.log(`\n--- 2) IMAGE MESSAGES ONLY (${images.length} total, ${buyerImages.length} from buyer) ---\n`);
  if (images.length === 0) {
    console.log('   (no image messages in this order chat)');
  } else {
    images.forEach((m, i) => {
      console.log(`   [${i + 1}] type=${m.type}  self=${m.self}  ${m.self === true ? '(WE sent)' : '(BUYER sent)'}`);
      console.log(`       id           : ${m.id}`);
      console.log(`       uuid         : ${m.uuid}`);
      console.log(`       imageUrl     : ${m.imageUrl}`);
      console.log(`       thumbnailUrl : ${m.thumbnailUrl}`);
      console.log(`       imageType    : ${m.imageType}   size: ${m.width}x${m.height}`);
      console.log(`       createTime   : ${m.createTime}  (${m.createTime ? new Date(m.createTime).toISOString() : 'n/a'})`);
      console.log(`       fromNickName : ${m.fromNickName}`);
      console.log('');
    });
  }

  console.log(`--- 3) MESSAGE TYPE BREAKDOWN ---`);
  const byType = {};
  msgs.forEach(m => { byType[m.type] = (byType[m.type] || 0) + 1; });
  console.log('   ' + JSON.stringify(byType));
}

(async () => {
  try {
    if (orderArg) {
      await dumpOrder(orderArg);
    } else {
      console.log('\nNo order number given — scanning recent orders for chat images...\n');
      const orders = await listRecentOrders();
      const found = [];
      for (const o of orders.slice(0, 10)) {
        try {
          const raw = await getRawChat(o.orderNumber);
          const d = raw?.data || raw;
          const msgs = Array.isArray(d) ? d : d?.list || d?.data || [];
          const imgs = msgs.filter(m => m?.type === 'image' && m.self !== true);
          console.log(`  order ${o.orderNumber}  status=${o.orderStatus}  buyerImages=${imgs.length}`);
          if (imgs.length) found.push(o.orderNumber);
        } catch (e) {
          console.log(`  order ${o.orderNumber} -> chat read error: ${e.response?.data?.msg || e.message}`);
        }
      }
      if (found.length) {
        console.log(`\nDumping full chat for the most recent order WITH images: ${found[0]}`);
        await dumpOrder(found[0]);
      } else {
        console.log('\nNo orders with buyer images found in the last 10 orders.');
        console.log('Ask the buyer to upload an image, then run:');
        console.log('  node scripts/dump-chat-images.js <orderNumber>');
      }
    }
  } catch (e) {
    console.log('ERROR:', e.response?.status, JSON.stringify(e.response?.data || e.message));
  }
  process.exit(0);
})();
