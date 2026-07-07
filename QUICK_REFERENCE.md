# Quick Reference Guide ⚡

## 30-Second Setup

```bash
# 1. Install MySQL
# Download from: https://dev.mysql.com/downloads/mysql/

# 2. Create database
mysql -u root -p -e "
CREATE DATABASE agpssvda1_p2p CHARACTER SET utf8mb4;
CREATE USER 'agpssvda1_p2p_user'@'localhost' IDENTIFIED BY 'Createmy@123456';
GRANT ALL PRIVILEGES ON agpssvda1_p2p.* TO 'agpssvda1_p2p_user'@'localhost';
FLUSH PRIVILEGES;
"

# 3. Run migration
node run-migration.js

# 4. Update .env with seller keys
# BINANCE_SELLER_API_KEY=your_key
# BINANCE_SELLER_SECRET_KEY=your_secret
# SELLER_ID=1135945063

# 5. Start backend
npm start

# 6. Start frontend
cd ../p2p-bot-frontend && npm run dev
```

---

## Essential .env Variables

```env
# Database
DB_HOST=localhost
DB_USER=agpssvda1_p2p_user
DB_PASS=Createmy@123456
DB_NAME=agpssvda1_p2p

# Seller Keys (ADD THESE!)
BINANCE_SELLER_API_KEY=your_seller_api_key
BINANCE_SELLER_SECRET_KEY=your_seller_secret_key
SELLER_ID=1135945063
```

---

## Key Files

| File | Purpose |
|------|---------|
| `LOCAL_DB_SETUP.md` | Database setup guide (English) |
| `LOCAL_DB_SETUP_HI.md` | Database setup guide (Hindi) |
| `SELLER_API_KEYS_SETUP.md` | API keys configuration |
| `SETUP_SUMMARY.md` | Complete overview |
| `src/seller/SYNC_SETUP.md` | Sync troubleshooting |
| `src/seller/SELLER_ID_CONFIG.md` | Seller ID guide |

---

## Common Commands

```bash
# Start MySQL
net start MySQL80

# Stop MySQL
net stop MySQL80

# Connect to database
mysql -u agpssvda1_p2p_user -p agpssvda1_p2p

# Run migration
node run-migration.js

# Start backend
npm start

# Start frontend
cd ../p2p-bot-frontend && npm run dev

# Test database
node -e "const m=require('mysql2/promise');require('dotenv').config();(async()=>{try{const c=await m.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});console.log('✅ OK');await c.end()}catch(e){console.error('❌',e.message)}})();"
```

---

## Ports

| Service | Port |
|---------|------|
| MySQL | 3306 |
| Backend | 5000 |
| Frontend | 3000 |

---

## Database Tables

After migration, you have:

```sql
seller_ads                    -- Synced ads from Binance
seller_ad_rules              -- Ad-specific rules (11 criteria + 3 methods)
seller_orders                -- Orders for seller ads
seller_order_state_log       -- Order state changes
seller_verification_documents -- KYC documents
seller_order_messages        -- Chat messages
seller_payment_history       -- Payment tracking
seller_buyer_metrics         -- Cached buyer metrics
```

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/seller/sync/ads` | POST | Sync ads from Binance |
| `/api/seller/ads` | GET | List all ads |
| `/api/seller/ads/:adNo/rules` | PUT | Update ad rules |
| `/api/seller/dashboard` | GET | Dashboard overview |
| `/api/seller/orders` | GET | List orders |

---

## Sync Process

```
Frontend: Click "Sync from Binance"
         ↓
Backend: POST /api/seller/sync/ads
         ↓
Uses: BINANCE_SELLER_API_KEY
         ↓
Fetches: Seller ads from Binance
         ↓
Stores: In seller_ads table
         ↓
Frontend: Shows ads in list
```

---

## Troubleshooting Quick Fixes

| Problem | Fix |
|---------|-----|
| MySQL won't start | `net start MySQL80` |
| "Access denied" | Check password in .env |
| Database not found | Run `node run-migration.js` |
| Backend won't start | Check .env DB credentials |
| No ads syncing | Check BINANCE_SELLER_API_KEY, Verify C2C permission |
| Port 3306 in use | `taskkill /PID <process_id> /F` |
| "Invalid API key" | Regenerate key on Binance |

---

## Configuration Checklist

- [ ] MySQL installed and running
- [ ] Database created: `agpssvda1_p2p`
- [ ] User created: `agpssvda1_p2p_user`
- [ ] Migration run: 8 tables created
- [ ] .env has DB credentials
- [ ] .env has BINANCE_SELLER_API_KEY
- [ ] .env has BINANCE_SELLER_SECRET_KEY
- [ ] .env has SELLER_ID=1135945063
- [ ] Backend starts without errors
- [ ] Frontend loads at http://localhost:3000

---

## Testing

```bash
# 1. Database working?
mysql -u agpssvda1_p2p_user -p agpssvda1_p2p -e "SHOW TABLES;"

# 2. Backend working?
curl http://localhost:5000/api/seller/sync/status

# 3. Ads synced?
mysql -u agpssvda1_p2p_user -p agpssvda1_p2p -e "SELECT * FROM seller_ads;"

# 4. Correct seller_id?
# Should show: 1135945063
```

---

## Architecture at a Glance

```
BUYER                    SELLER
├─ BINANCE_API_KEY      ├─ BINANCE_SELLER_API_KEY
├─ binanceService       ├─ sellerBinanceService
├─ OrderPoller          ├─ SyncController
└─ Buyer Dashboard      └─ Seller Dashboard
```

---

## What's New

✨ **Created Files:**
- `src/config/sellerBinanceConfig.js` - Seller Binance config
- `src/services/sellerBinanceService.js` - Seller API calls
- `src/seller/utils/sellerUtils.js` - Helper functions
- `LOCAL_DB_SETUP.md` - Database guide (English)
- `LOCAL_DB_SETUP_HI.md` - Database guide (Hindi)

📝 **Updated Files:**
- `.env` - Added seller API keys
- `src/seller/controllers/*` - Use seller Binance service

---

## Next Steps

1. Follow `LOCAL_DB_SETUP.md` to setup database
2. Add seller API keys to `.env`
3. Run `npm start` to start backend
4. Click "Sync from Binance" in UI
5. Verify ads appear in dashboard

---

## Learn More

- Full database guide: `LOCAL_DB_SETUP.md`
- API keys setup: `SELLER_API_KEYS_SETUP.md`
- Seller ID configuration: `src/seller/SELLER_ID_CONFIG.md`
- Sync troubleshooting: `src/seller/SYNC_SETUP.md`
- Complete overview: `SETUP_SUMMARY.md`

---

**Ready to go! Start with LOCAL_DB_SETUP.md** 🚀
