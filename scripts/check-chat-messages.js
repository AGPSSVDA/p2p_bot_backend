/**
 * Debug Script: Check Chat Messages for Liveness Completion
 *
 * Purpose: Monitor chat messages to find the liveness completion indicator
 * Binance sends a system message when liveness is completed
 *
 * Usage:
 *   node scripts/check-chat-messages.js <orderNumber>
 *
 * Example:
 *   node scripts/check-chat-messages.js 22908994947558567936
 */

require('dotenv').config();
const sellerOrderDbService = require('../src/seller/services/sellerOrderDbService');

const TEST_ORDER_NUMBER = process.argv[2];

if (!TEST_ORDER_NUMBER) {
  console.log(`
Usage: node scripts/check-chat-messages.js <orderNumber>
Example: node scripts/check-chat-messages.js 22908994947558567936
  `);
  process.exit(1);
}

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  DEBUG: Check Chat Messages for Liveness Completion           ║
╚════════════════════════════════════════════════════════════════╝

Order Number: ${TEST_ORDER_NUMBER}

Checking database for any chat messages related to this order...
════════════════════════════════════════════════════════════════\n
`);

(async () => {
  try {
    // Get all messages for this order
    const query = `
      SELECT
        id,
        direction,
        sender,
        message_type,
        message_content,
        sent_at,
        binance_msg_id
      FROM seller_order_messages
      WHERE order_number = ?
      ORDER BY sent_at DESC
      LIMIT 20
    `;

    const pool = require('../src/db/mysql');
    const [messages] = await pool.query(query, [TEST_ORDER_NUMBER]);

    if (messages.length === 0) {
      console.log(`❌ No messages found for this order in database\n`);
      console.log(`Note: Messages may not be persisted yet\n`);
    } else {
      console.log(`✅ Found ${messages.length} messages:\n`);

      messages.forEach((msg, index) => {
        console.log(`Message #${index + 1}:`);
        console.log(`  Sent At: ${msg.sent_at}`);
        console.log(`  Direction: ${msg.direction}`);
        console.log(`  Sender: ${msg.sender}`);
        console.log(`  Type: ${msg.message_type}`);
        console.log(`  Content: ${msg.message_content}`);
        console.log(`  Binance ID: ${msg.binance_msg_id}\n`);

        // Look for liveness-related keywords
        if (msg.message_content && msg.message_content.toLowerCase().includes('liveness')) {
          console.log(`  🎯 THIS MESSAGE IS LIVENESS-RELATED!\n`);
        }
      });
    }

    console.log(`════════════════════════════════════════════════════════════════\n`);
    console.log(`Key findings:`);
    console.log(`  1. When liveness completes, Binance sends a chat message`);
    console.log(`  2. The message may contain keywords like: "liveness", "verified", "passed"\n`);
    console.log(`Recommendations:`);
    console.log(`  - Monitor chat messages for liveness completion\n`);
    console.log(`  - Instead of polling additionalKycVerify, check for completion message\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
})();
