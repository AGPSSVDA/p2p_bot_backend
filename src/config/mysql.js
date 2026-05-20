const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "p2p",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Full default chat-template catalog mirrored from src/bot/messages.js.
// Placeholders use {name} syntax and are substituted at send-time by messageService.
const TEMPLATE_DEFAULTS = [
  {
    key: "welcome",
    description: "Sent immediately when a new order is detected",
    sort_order: 1,
    messages: [
      {
        order: 1,
        text:
          "🔔 *IMPORTANT INSTRUCTION*\n" +
          "• Please read *all messages carefully*.\n" +
          "• The entire process is *automated* — the system will send only essential prompts.\n" +
          "• To avoid delays, *follow each prompt exactly* as shown.\n\n" +
          "✅ Just follow the instructions, and everything will be handled *automatically*.",
      },
    ],
  },
  {
    key: "panRequest",
    description: "Asks seller to share their PAN",
    sort_order: 2,
    messages: [
      {
        order: 1,
        text:
          "Thanks for choosing us 🙏\n\n" +
          "For TDS deduction, we need your PAN.\n" +
          "Please *type* your PAN directly — do not send images.\n\n" +
          "Format: ABCDE-1234-F (5 letters + 4 digits + 1 letter)",
      },
    ],
  },
  {
    key: "panNotFound",
    description: "Sent when PAN can't be detected in seller's reply",
    sort_order: 3,
    messages: [
      {
        order: 1,
        text:
          "We could not detect a valid PAN in your reply.\n\n" +
          "Please type your PAN (text only, no images).\n" +
          "Format: ABCDE-1234-F",
      },
    ],
  },
  {
    key: "panImageRejected",
    description: "Sent when seller sends image instead of typing PAN",
    sort_order: 4,
    messages: [
      {
        order: 1,
        text:
          "🚫 We cannot read images.\n\n" +
          "Please *type* your PAN directly in chat.\n" +
          "Format: ABCDE-1234-F",
      },
    ],
  },
  {
    key: "panInvalidFormat",
    description: "Sent when PAN string doesn't match required format",
    sort_order: 5,
    messages: [
      {
        order: 1,
        text:
          "❌ Invalid PAN format.\n\n" +
          "Correct format: ABCDE-1234-F\n" +
          "(5 letters + 4 digits + 1 letter)\n\n" +
          "Please re-enter your PAN.",
      },
    ],
  },
  {
    key: "panApiInvalid",
    description: "Sent when Surepass returns invalid (placeholder: {reason})",
    sort_order: 6,
    messages: [
      {
        order: 1,
        text:
          "❌ Could not process the PAN you sent.\n\n" +
          "Reason: {reason}\n\n" +
          "Please double-check and resend your correct PAN.",
      },
    ],
  },
  {
    key: "panVerifiedTds",
    description: "Sent when PAN is verified. Placeholders: {pan}, {panName}, {preTDS}, {tds}, {postTDS}",
    sort_order: 7,
    messages: [
      {
        order: 1,
        text:
          "✅ PAN verified successfully.\n\n" +
          "Name on PAN     : {panName}\n" +
          "PAN             : {pan}\n\n" +
          "Your order is being prepared. Please wait for an update. ⏳\n\n" +
          "Amount (Pre-TDS)  : ₹{preTDS}\n" +
          "TDS Amount [1.0%] : ₹{tds}\n" +
          "Amount (Post-TDS) : ₹{postTDS}\n\n" +
          "😊 You will receive ₹{postTDS} in your registered account.",
      },
    ],
  },
  {
    key: "tdsInfo",
    description: "TDS credit timing info ({tds}, {quarter}, {creditMonth}, {visibleMonth}, {year})",
    sort_order: 8,
    messages: [
      {
        order: 1,
        text:
          "📋 TDS of ₹{tds} will be deducted and credited to your PAN in the first month of the next quarter.\n" +
          "It will be visible on your PAN in the second month of the next quarter.\n\n" +
          "📅 Current Quarter: {quarter} {year}\n" +
          "💰 Crediting: {creditMonth} {year}\n" +
          "👁️ Visible From: {visibleMonth} {year}",
      },
    ],
  },
  {
    key: "tdsConsent",
    description: "Asks seller to reply 'I AGREE' to confirm TDS deduction ({postTDS}, {tds})",
    sort_order: 9,
    messages: [
      {
        order: 1,
        text:
          "We will pay ₹{postTDS} (Post-TDS) to your registered account.\n\n" +
          "Do you agree with the TDS deduction?\n\n" +
          "To confirm, please reply within 600 seconds:\n" +
          "👇 👇 👇\n\n" +
          "💳 🔥 I AGREE 🔥 💳\n\n" +
          "If no response within this time, we will consider it as your consent.\n" +
          "The TDS amount of ₹{tds} will be deposited on your PAN.",
      },
    ],
  },
  {
    key: "tdsConsentRetry",
    description: "Sent when reply is not a valid agreement message",
    sort_order: 10,
    messages: [
      {
        order: 1,
        text:
          "Please reply *I AGREE* to confirm TDS deduction and proceed.\n\n" +
          "💳 🔥 I AGREE 🔥 💳",
      },
    ],
  },
  {
    key: "consentReceived",
    description: "Acknowledges TDS consent and starts payment flow",
    sort_order: 11,
    messages: [
      {
        order: 1,
        text:
          "Thank you! ✅\n\n" +
          "• Your PAN details are now securely stored for future orders.\n" +
          "• This approval covers TDS for all future transactions.\n" +
          "• Next time, just place your order — no need to resubmit PAN.\n\n" +
          "Processing your payment now... 🔒💾",
      },
    ],
  },
  {
    key: "paymentSent",
    description: "Sent after auto-payout succeeds ({method}, {utr}, {tan})",
    sort_order: 12,
    messages: [
      {
        order: 1,
        text:
          "{method} done — UTR: {utr}\n\n" +
          "You'll receive payment in the next 2–20 minutes.\n" +
          "Kindly *release* the order once you receive it. 🙏\n\n" +
          "As mentioned, 1% TDS was deducted and will be deposited on your PAN — " +
          "you can claim it back when you file ITR.\n\n" +
          "Our TAN: {tan}\n\n" +
          "(Automated response — payment screenshot can't be shared)",
      },
    ],
  },
  {
    key: "manualPaymentPending",
    description: "Phase 1 manual payout placeholder ({postTDS}, {method})",
    sort_order: 13,
    messages: [
      {
        order: 1,
        text:
          "✅ Processing complete! Payment is being prepared.\n\n" +
          "Amount: ₹{postTDS} (Post-TDS)\n" +
          "Method: {method}\n\n" +
          "You'll receive payment shortly. Please release the crypto once you receive it. 🙏",
      },
    ],
  },
  {
    key: "panReminder",
    description: "First reminder when seller hasn't shared PAN",
    sort_order: 14,
    messages: [
      {
        order: 1,
        text:
          "⏰ Reminder: We are waiting for your PAN.\n\n" +
          "Please type it now (Format: ABCDE-1234-F).",
      },
    ],
  },
  {
    key: "panLastWarning",
    description: "Final warning before auto-cancel",
    sort_order: 15,
    messages: [
      {
        order: 1,
        text:
          "⚠️ Last warning!\n\n" +
          "Order will be cancelled in 2 minutes if your PAN is not received.\n\n" +
          "Please send your PAN now.",
      },
    ],
  },
  {
    key: "orderCancelled",
    description: "Sent when order is auto-cancelled due to no response",
    sort_order: 16,
    messages: [
      {
        order: 1,
        text:
          "❌ Order has been cancelled due to no response.\n\n" +
          "If you wish to trade, please place a new order.",
      },
    ],
  },
  {
    key: "panMaxRetries",
    description: "Sent when too many invalid PAN attempts",
    sort_order: 17,
    messages: [
      {
        order: 1,
        text:
          "❌ Too many incorrect PAN attempts.\n\n" +
          "Your order has been escalated for manual review. " +
          "We will contact you shortly. Please wait.",
      },
    ],
  },
  {
    key: "nameMismatch",
    description: "Sent when PAN name doesn't match KYC/bank name. Placeholders: {panName}, {kycName}, {accountName}, {mismatchedSources}",
    sort_order: 18,
    messages: [
      {
        order: 1,
        text:
          "❌ Name mismatch detected.\n\n" +
          "PAN Name        : {panName}\n" +
          "Binance KYC     : {kycName}\n" +
          "Bank Holder     : {accountName}\n\n" +
          "Mismatch with   : {mismatchedSources}\n\n" +
          "As a security measure, this order has been escalated for manual review. " +
          "Our team will reach out to you shortly.",
      },
    ],
  },
  {
    key: "panApiDown",
    description: "Sent when PAN verification API is unreachable",
    sort_order: 19,
    messages: [
      {
        order: 1,
        text:
          "⏳ Our processing system is temporarily unavailable.\n\n" +
          "Please wait 2–5 minutes and re-send your PAN.\n" +
          "If the issue continues, our team will assist you shortly. 🙏",
      },
    ],
  },
  {
    key: "orderCancelledRemote",
    description: "Sent when seller cancels order on Binance",
    sort_order: 20,
    messages: [
      {
        order: 1,
        text:
          "Your order has been cancelled.\n\n" +
          "Thank you for considering us — please feel free to place a new " +
          "order anytime. We look forward to trading with you. 🙏",
      },
    ],
  },
  {
    key: "systemError",
    description: "Generic safety-net message for unexpected failures",
    sort_order: 21,
    messages: [
      {
        order: 1,
        text:
          "⚠️ A temporary issue occurred while processing your order.\n\n" +
          "Please wait a moment — we are looking into it. " +
          "Do not cancel the order; our team will assist you shortly.",
      },
    ],
  },
  {
    key: "escalated",
    description: "Sent when order is escalated for manual review",
    sort_order: 22,
    messages: [
      {
        order: 1,
        text:
          "⚠️ Your order is under manual review.\n\n" +
          "We will contact you shortly. Please wait.",
      },
    ],
  },
  {
    key: "paymentFailed",
    description: "Sent when payment processing throws an error",
    sort_order: 23,
    messages: [
      {
        order: 1,
        text:
          "❌ A technical issue occurred during payment processing.\n\n" +
          "Our team is looking into it. Please wait 5–10 minutes.\n" +
          "Do not cancel the order.",
      },
    ],
  },
  {
    key: "thankYou",
    description: "Final thank-you on order completion ({asset}, {cryptoAmount}, {orderNo})",
    sort_order: 24,
    messages: [
      {
        order: 1,
        text:
          "🎉 Thank you for trading with us!\n\n" +
          "{cryptoAmount} {asset} has been transferred to your wallet.\n\n" +
          "We look forward to trading with you again! 🙏",
      },
    ],
  },
  {
    key: "waitProcessing",
    description: "Generic 'please wait' message during processing states",
    sort_order: 25,
    messages: [
      {
        order: 1,
        text: "Please wait — your order is being processed... 🔄",
      },
    ],
  },
  {
    key: "waitRelease",
    description: "Sent when seller messages after payment is already sent ({method})",
    sort_order: 26,
    messages: [
      {
        order: 1,
        text:
          "Payment has already been sent. " +
          "Please check your {method} and release the crypto. ✅",
      },
    ],
  },
  {
    key: "returningSellerTdsApplied",
    description:
      "Returning seller — TDS applied automatically using previously-verified PAN. " +
      "Placeholders: {previousOrderNo}, {pan}, {panName}, {preTDS}, {tds}, {postTDS}",
    sort_order: 27,
    messages: [
      {
        order: 1,
        text:
          "🔹 *TDS Deduction Overview:*\n" +
          "As you agreed during your previous order (Order Number: {previousOrderNo}), we deduct 1% TDS on crypto transactions as mandated by Indian tax laws. " +
          "Your PAN card number {pan}, which is securely saved with us, will be used to deposit this TDS to your PAN card.",
      },
      {
        order: 2,
        text:
          "🔹 *TDS Deduction Approval:*\n" +
          "✅ As you had previously approved the TDS deduction on future transactions during your earlier order with us, we have applied the TDS deduction to this transaction as well.",
      },
      {
        order: 3,
        text:
          "🔹 *Your Transaction Summary:*\n" +
          "🥳 Amount Credited to You: ₹{postTDS} (transferred to your bank account).\n" +
          "📋 TDS Deducted: ₹{tds} (1% of the transaction value).\n" +
          "📅 TDS Deposit Timeline: ₹{tds} will be deposited to your PAN within the prescribed timelines as per Indian tax laws.\n\n" +
          "Thank you for your continued trust! 🙏",
      },
    ],
  },
];

// ── Migration helpers ───────────────────────────────────────────────────────
// Adds any missing columns to an existing table. `columns` is an array of
// { name, def } pairs where `def` is the full column definition. Idempotent —
// safe to run on every boot.
async function ensureColumns(conn, table, columns) {
  const [existing] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  const present = new Set(existing.map((r) => r.COLUMN_NAME.toLowerCase()));
  for (const col of columns) {
    if (!present.has(col.name.toLowerCase())) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col.name}\` ${col.def}`);
      console.log(`   • migrated ${table}: added column ${col.name}`);
    }
  }
}

// Relaxes a NOT NULL column on a legacy table to allow NULL so new inserts
// that don't supply it don't fail. No-op if the column doesn't exist or is
// already nullable.
async function relaxColumnToNullable(conn, table, columnName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, columnName]
  );
  if (rows.length === 0) return;
  if (rows[0].IS_NULLABLE === 'YES') return;
  await conn.query(
    `ALTER TABLE \`${table}\` MODIFY COLUMN \`${columnName}\` ${rows[0].COLUMN_TYPE} NULL`
  );
  console.log(`   • migrated ${table}: relaxed ${columnName} to NULL`);
}

// Adds a secondary index if it doesn't already exist on the table.
async function ensureIndex(conn, table, indexName, columns) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (rows.length === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`);
    console.log(`   • migrated ${table}: added index ${indexName}`);
  }
}

async function initMysql() {
  try {
    const connection = await pool.getConnection();
    console.log("✅ MySQL connected successfully.");

    // ── users ─────────────────────────────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'user') DEFAULT 'user',
        login_id VARCHAR(36) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const [loginIdCol] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'login_id'`
    );
    if (loginIdCol.length === 0) {
      await connection.query(
        "ALTER TABLE users ADD COLUMN login_id VARCHAR(36) NULL AFTER role"
      );
    }
    const [isLoginCol] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_login'`
    );
    if (isLoginCol.length > 0) {
      await connection.query("ALTER TABLE users DROP COLUMN is_login");
    }

    const [adminExists] = await connection.query("SELECT * FROM users WHERE email = 'admin@gmail.com'");
    if (adminExists.length === 0) {
      await connection.query(
        "INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
        ['admin@gmail.com', '$2b$10$TwoLwC0AVW7STw9MKVdyb.ccuXHCzqcxWhN1uwm7E9n5eBTrVyTLu', 'admin']
      );
      console.log("✅ Default admin user created.");
    }

    // ── template_groups + template_messages ───────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS template_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        template_key VARCHAR(100) UNIQUE NOT NULL,
        small_description VARCHAR(255) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS template_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        template_id INT NOT NULL,
        message_text TEXT NOT NULL,
        step_order INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES template_groups(id) ON DELETE CASCADE
      )
    `);

    // ── payouts ───────────────────────────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS payouts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE NOT NULL,
        pan_name VARCHAR(100),
        seller_pan VARCHAR(20),
        total_order_amount DECIMAL(15, 2),
        tds_amount DECIMAL(15, 2),
        amount DECIMAL(15, 2),
        utr_number VARCHAR(50),
        upi_id VARCHAR(100) NULL,
        payment_method VARCHAR(50) NULL,
        status VARCHAR(20) DEFAULT 'SUCCESS',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add new columns to payouts for older installs
    for (const col of [
      { name: 'upi_id', def: 'VARCHAR(100) NULL' },
      { name: 'payment_method', def: 'VARCHAR(50) NULL' },
    ]) {
      const [rows] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts' AND COLUMN_NAME = ?`,
        [col.name]
      );
      if (rows.length === 0) {
        await connection.query(`ALTER TABLE payouts ADD COLUMN ${col.name} ${col.def}`);
      }
    }

    // ── bot_config ────────────────────────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bot_status TINYINT(1) NOT NULL DEFAULT 0,
        auto_payout TINYINT(1) NOT NULL DEFAULT 0,
        bot_name VARCHAR(100) NULL,
        logo VARCHAR(500) NULL,
        auto_cancel_buffer_ms INT NOT NULL DEFAULT 60000,
        pan_timeout_ms INT NOT NULL DEFAULT 600000,
        pan_reminder_ms INT NOT NULL DEFAULT 300000,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Migration: ensure new tunable columns exist on legacy bot_config rows.
    await ensureColumns(connection, 'bot_config', [
      { name: 'auto_cancel_buffer_ms', def: 'INT NOT NULL DEFAULT 60000' },
      { name: 'pan_timeout_ms',        def: 'INT NOT NULL DEFAULT 600000' },
      { name: 'pan_reminder_ms',       def: 'INT NOT NULL DEFAULT 300000' },
    ]);

    // ── orders (DB-persisted lifecycle) ───────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) UNIQUE NOT NULL,
        adv_no VARCHAR(64) NULL,
        trade_type VARCHAR(8) NULL,
        asset VARCHAR(16) NULL,
        fiat VARCHAR(8) NULL,
        amount DECIMAL(18, 2) NULL,
        crypto_amount DECIMAL(28, 8) NULL,
        seller_nickname VARCHAR(120) NULL,
        seller_user_id VARCHAR(64) NULL,
        seller_name VARCHAR(120) NULL,
        pan VARCHAR(20) NULL,
        pan_name VARCHAR(120) NULL,
        pan_retries INT NOT NULL DEFAULT 0,
        name_match_status VARCHAR(20) NULL,
        name_match_compare_source VARCHAR(32) NULL,
        payment_method VARCHAR(32) NULL,
        upi_id VARCHAR(100) NULL,
        account_no VARCHAR(64) NULL,
        ifsc_code VARCHAR(32) NULL,
        bank_name VARCHAR(120) NULL,
        account_name VARCHAR(120) NULL,
        pre_tds_amount DECIMAL(18, 2) NULL,
        tds_amount DECIMAL(18, 2) NULL,
        post_tds_amount DECIMAL(18, 2) NULL,
        payout_id VARCHAR(64) NULL,
        utr_number VARCHAR(64) NULL,
        confirm_pay_end_time DATETIME NULL,
        notify_pay_end_time DATETIME NULL,
        state VARCHAR(40) NOT NULL DEFAULT 'NEW_ORDER',
        cancel_reason VARCHAR(255) NULL,
        completed_at DATETIME NULL,
        cancelled_at DATETIME NULL,
        escalated_at DATETIME NULL,
        processed_by VARCHAR(16) NOT NULL DEFAULT 'BOT',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_orders_state (state),
        INDEX idx_orders_created (created_at),
        INDEX idx_orders_adv (adv_no),
        INDEX idx_orders_processed_by (processed_by)
      )
    `);

    // Migration: bring legacy `orders` tables up to the current schema.
    await ensureColumns(connection, 'orders', [
      { name: 'order_no',                   def: 'VARCHAR(64) NULL' },
      { name: 'adv_no',                     def: 'VARCHAR(64) NULL' },
      { name: 'trade_type',                 def: 'VARCHAR(8) NULL' },
      { name: 'asset',                      def: 'VARCHAR(16) NULL' },
      { name: 'fiat',                       def: 'VARCHAR(8) NULL' },
      { name: 'amount',                     def: 'DECIMAL(18, 2) NULL' },
      { name: 'crypto_amount',              def: 'DECIMAL(28, 8) NULL' },
      { name: 'seller_nickname',            def: 'VARCHAR(120) NULL' },
      { name: 'seller_user_id',             def: 'VARCHAR(64) NULL' },
      { name: 'seller_name',                def: 'VARCHAR(120) NULL' },
      { name: 'pan',                        def: 'VARCHAR(20) NULL' },
      { name: 'pan_name',                   def: 'VARCHAR(120) NULL' },
      { name: 'pan_retries',                def: 'INT NOT NULL DEFAULT 0' },
      { name: 'name_match_status',          def: 'VARCHAR(20) NULL' },
      { name: 'name_match_compare_source',  def: 'VARCHAR(32) NULL' },
      { name: 'payment_method',             def: 'VARCHAR(32) NULL' },
      { name: 'upi_id',                     def: 'VARCHAR(100) NULL' },
      { name: 'account_no',                 def: 'VARCHAR(64) NULL' },
      { name: 'ifsc_code',                  def: 'VARCHAR(32) NULL' },
      { name: 'bank_name',                  def: 'VARCHAR(120) NULL' },
      { name: 'account_name',               def: 'VARCHAR(120) NULL' },
      { name: 'pre_tds_amount',             def: 'DECIMAL(18, 2) NULL' },
      { name: 'tds_amount',                 def: 'DECIMAL(18, 2) NULL' },
      { name: 'post_tds_amount',            def: 'DECIMAL(18, 2) NULL' },
      { name: 'payout_id',                  def: 'VARCHAR(64) NULL' },
      { name: 'utr_number',                 def: 'VARCHAR(64) NULL' },
      { name: 'confirm_pay_end_time',       def: 'DATETIME NULL' },
      { name: 'notify_pay_end_time',        def: 'DATETIME NULL' },
      { name: 'state',                      def: "VARCHAR(40) NOT NULL DEFAULT 'NEW_ORDER'" },
      { name: 'cancel_reason',              def: 'VARCHAR(255) NULL' },
      { name: 'completed_at',               def: 'DATETIME NULL' },
      { name: 'cancelled_at',               def: 'DATETIME NULL' },
      { name: 'escalated_at',               def: 'DATETIME NULL' },
      // Provenance flag: BOT = handled end-to-end by the bot (chat, PAN, TDS,
      // payment). MANUAL = order existed on Binance and was pulled in via the
      // sync without the bot's live flow ever touching it.
      { name: 'processed_by',               def: "VARCHAR(16) NOT NULL DEFAULT 'BOT'" },
      { name: 'created_at',                 def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at',                 def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    ]);
    await ensureIndex(connection, 'orders', 'idx_orders_state', 'state');
    await ensureIndex(connection, 'orders', 'idx_orders_processed_by', 'processed_by');
    await ensureIndex(connection, 'orders', 'idx_orders_created', 'created_at');
    await ensureIndex(connection, 'orders', 'idx_orders_adv', 'adv_no');

    // Relax any legacy NOT NULL columns that pre-date the current schema so
    // new inserts (which don't know about them) don't fail with
    // "Field 'X' doesn't have a default value".
    for (const col of [
      'order_id',          // legacy identifier — replaced by order_no
      'binance_uid',
      'status',            // legacy — replaced by `state`
      'pan_attempts',      // legacy — replaced by `pan_retries`
      'pan_hash',
      'verified_pan_name',
      'beneficiary_name',
      'payment_account_info',
      'name_match_score',
    ]) {
      await relaxColumnToNullable(connection, 'orders', col);
    }

    // ── order_state_log ───────────────────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_state_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL,
        from_state VARCHAR(40) NULL,
        to_state VARCHAR(40) NOT NULL,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_state_log_order (order_no),
        INDEX idx_state_log_created (created_at)
      )
    `);
    await ensureColumns(connection, 'order_state_log', [
      { name: 'order_no',   def: 'VARCHAR(64) NOT NULL' },
      { name: 'from_state', def: 'VARCHAR(40) NULL' },
      { name: 'to_state',   def: 'VARCHAR(40) NOT NULL' },
      { name: 'reason',     def: 'VARCHAR(255) NULL' },
      { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
    ]);

    // ── ads ───────────────────────────────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        adv_no VARCHAR(64) UNIQUE NOT NULL,
        trade_type VARCHAR(8) NULL,
        asset VARCHAR(16) NULL,
        fiat VARCHAR(8) NULL,
        price DECIMAL(18, 4) NULL,
        min_amount DECIMAL(18, 2) NULL,
        max_amount DECIMAL(18, 2) NULL,
        status VARCHAR(20) NULL,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NULL,
        last_synced_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await ensureColumns(connection, 'ads', [
      { name: 'adv_no',         def: 'VARCHAR(64) NULL' },
      { name: 'trade_type',     def: 'VARCHAR(8) NULL' },
      { name: 'asset',          def: 'VARCHAR(16) NULL' },
      { name: 'fiat',           def: 'VARCHAR(8) NULL' },
      { name: 'price',          def: 'DECIMAL(18, 4) NULL' },
      { name: 'min_amount',     def: 'DECIMAL(18, 2) NULL' },
      { name: 'max_amount',     def: 'DECIMAL(18, 2) NULL' },
      { name: 'status',         def: 'VARCHAR(20) NULL' },
      { name: 'first_seen_at',  def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
      { name: 'last_seen_at',   def: 'TIMESTAMP NULL' },
      { name: 'last_synced_at', def: 'TIMESTAMP NULL' },
    ]);

    // ── order_messages (audit trail of every chat sent / received) ────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL,
        direction ENUM('IN', 'OUT') NOT NULL,
        sender VARCHAR(32) NULL,
        template_key VARCHAR(100) NULL,
        message_text TEXT NOT NULL,
        sent_status VARCHAR(20) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_msg_order (order_no),
        INDEX idx_msg_created (created_at)
      )
    `);
    await ensureColumns(connection, 'order_messages', [
      { name: 'order_no',     def: 'VARCHAR(64) NOT NULL' },
      { name: 'direction',    def: "ENUM('IN', 'OUT') NOT NULL" },
      { name: 'sender',       def: 'VARCHAR(32) NULL' },
      { name: 'template_key', def: 'VARCHAR(100) NULL' },
      { name: 'message_text', def: 'TEXT NOT NULL' },
      { name: 'sent_status',  def: 'VARCHAR(20) NULL' },
      { name: 'created_at',   def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
    ]);

    // ── RESET (one-shot via .env flag) ────────────────────────────────────────
    // Set RESET_DATA_ON_BOOT=true in .env, restart once, then set it back to
    // false. Truncates all transactional + template + bot_config tables and
    // re-seeds defaults. Login users are intentionally preserved.
    const resetFlag = String(process.env.RESET_DATA_ON_BOOT || "").toLowerCase() === "true";
    if (resetFlag) {
      console.log("⚠️  RESET_DATA_ON_BOOT=true — wiping transactional tables...");
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      const wipeTables = [
        "order_messages",
        "order_state_log",
        "orders",
        "ads",
        "payouts",
        "template_messages",
        "template_groups",
        "bot_config",
      ];
      for (const t of wipeTables) {
        await connection.query(`TRUNCATE TABLE ${t}`);
        console.log(`   • truncated ${t}`);
      }
      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      console.log("✅ Wipe complete.");
    }

    // ── Seed templates (idempotent: only inserts keys not already present) ────
    for (const tpl of TEMPLATE_DEFAULTS) {
      const [existing] = await connection.query(
        "SELECT id FROM template_groups WHERE template_key = ?",
        [tpl.key]
      );

      if (existing.length === 0) {
        const [groupRes] = await connection.query(
          "INSERT INTO template_groups (template_key, small_description, sort_order) VALUES (?, ?, ?)",
          [tpl.key, tpl.description, tpl.sort_order]
        );
        const groupId = groupRes.insertId;

        for (const msg of tpl.messages) {
          await connection.query(
            "INSERT INTO template_messages (template_id, message_text, step_order) VALUES (?, ?, ?)",
            [groupId, msg.text, msg.order]
          );
        }
      }
    }

    // ── Seed default bot_config row if empty ──────────────────────────────────
    const [botCfgRows] = await connection.query("SELECT id FROM bot_config LIMIT 1");
    if (botCfgRows.length === 0) {
      await connection.query(
        "INSERT INTO bot_config (bot_status, auto_payout, bot_name, logo) VALUES (?, ?, ?, ?)",
        [0, 0, "P2P Trade Bot", null]
      );
      console.log("✅ Seeded default bot_config row.");
    }

    connection.release();
    console.log("✅ MySQL schema initialized.");
  } catch (err) {
    console.error("❌ MySQL Connection Failed:", err.message);
  }
}

module.exports = { pool, initMysql, TEMPLATE_DEFAULTS };
