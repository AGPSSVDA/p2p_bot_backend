const mysql = require('mysql2/promise');

(async () => {
  try {
    const pool = mysql.createPool({
      host: '127.0.0.1',
      user: 'root',
      password: '',
      database: 'agpssvda',
      connectTimeout: 30000,
    });
    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL');

    // Create convert_assets table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS convert_assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(16) UNIQUE NOT NULL,
        name VARCHAR(64) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ convert_assets table created');

    // Seed default assets
    const assets = [
      { symbol: 'BTC',  name: 'Bitcoin',     sort: 1 },
      { symbol: 'ETH',  name: 'Ethereum',    sort: 2 },
      { symbol: 'BNB',  name: 'BNB',         sort: 3 },
      { symbol: 'SOL',  name: 'Solana',      sort: 4 },
      { symbol: 'XRP',  name: 'Ripple',      sort: 5 },
      { symbol: 'ADA',  name: 'Cardano',     sort: 6 },
      { symbol: 'MATIC', name: 'Polygon',    sort: 7 },
      { symbol: 'DOGE', name: 'Dogecoin',    sort: 8 },
      { symbol: 'DOT',  name: 'Polkadot',    sort: 9 },
      { symbol: 'AVAX', name: 'Avalanche',   sort: 10 },
      { symbol: 'TRX',  name: 'TRON',        sort: 11 },
      { symbol: 'LTC',  name: 'Litecoin',    sort: 12 },
      { symbol: 'LINK', name: 'Chainlink',   sort: 13 },
      { symbol: 'USDC', name: 'USD Coin',    sort: 14 },
    ];

    for (const a of assets) {
      await conn.query(
        'INSERT IGNORE INTO convert_assets (symbol, name, enabled, sort_order) VALUES (?, ?, 0, ?)',
        [a.symbol, a.name, a.sort]
      );
    }
    console.log('✅ Seeded default convert assets');

    conn.release();
    pool.end();
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
