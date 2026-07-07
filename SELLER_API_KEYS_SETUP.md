# Seller API Keys Setup Guide

## Overview

Your system now uses **separate Binance API keys** for seller operations:
- **Buyer keys**: BINANCE_API_KEY, BINANCE_SECRET_KEY (for buyer operations)
- **Seller keys**: BINANCE_SELLER_API_KEY, BINANCE_SELLER_SECRET_KEY (for seller operations)

This keeps buyer and seller operations completely isolated.

---

## Configuration in .env

```env
# Buyer Account (Original keys)
BINANCE_API_KEY=KXHnvoP4AtdrCCKfIz1zn2iM6i9QKTpAZtOdGsM9kdX8DKIeWv8owpMSAYiOtPcf
BINANCE_SECRET_KEY=kdqk3rO67OPYT5UXvyGtAoGrLMBXwXTPLlTJVTmKGps3hwfFP3wKNyrN0MUrR4Zd

# Seller Account (Separate/Different keys)
BINANCE_SELLER_API_KEY=YOUR_SELLER_API_KEY_HERE
BINANCE_SELLER_SECRET_KEY=YOUR_SELLER_SECRET_KEY_HERE

# Seller Configuration
SELLER_ID=1135945063
SELLER_NAME=AGPSS GLOBAL PRIVATE LIMITED
```

---

## Files Updated

### 1. Config Files
- **`src/config/sellerBinanceConfig.js`** (NEW)
  - Seller-specific Binance configuration
  - Uses `BINANCE_SELLER_API_KEY` and `BINANCE_SELLER_SECRET_KEY`
  - Separate from buyer config

### 2. Service Files
- **`src/services/sellerBinanceService.js`** (NEW)
  - Seller-specific Binance operations
  - Functions:
    - `getSellerAds()` - Fetch seller's own ads
    - `getSellerAdDetail()` - Get specific ad details
    - `getSellerOrders()` - Get seller's orders
    - `verifySellerOwnsAd()` - Verify seller ownership

- **`src/seller/controllers/sellerSyncController.js`** (UPDATED)
  - Now uses `sellerBinanceService.getSellerAds()`
  - Uses seller credentials for syncing

---

## How It Works

```
Frontend: Click "Sync from Binance"
    ↓
Backend: POST /api/seller/sync/ads
    ↓
sellerSyncController.syncAdsFromBinance()
    ↓
sellerBinanceService.getSellerAds()
    ↓
Uses BINANCE_SELLER_API_KEY from .env
    ↓
Calls Binance P2P API
    ↓
Returns seller's own ads only
    ↓
Stores in seller_ads table
    ↓
Frontend displays ads
```

---

## API Key Requirements

Your Binance seller API key needs these permissions:

✅ **C2C Trading** - To access P2P merchant endpoints
✅ **Read** - To fetch ad information
✅ **IP Whitelist** - Your server's IP (if restricted)

### How to Get Keys

1. Go to: https://www.binance.com/en/account/api-management
2. Create new API key
3. Choose **Restrictions**:
   - ✅ Enable C2C Trading
   - ✅ Restrict access to trusted IPs (optional)
4. Copy API Key and Secret Key
5. Paste into .env:
   ```env
   BINANCE_SELLER_API_KEY=your_key_here
   BINANCE_SELLER_SECRET_KEY=your_secret_here
   ```

---

## Testing

### 1. Verify Configuration
```bash
# Check .env has both key sets
grep "BINANCE" .env
```

Should show:
```
BINANCE_API_KEY=...
BINANCE_SECRET_KEY=...
BINANCE_SELLER_API_KEY=...
BINANCE_SELLER_SECRET_KEY=...
```

### 2. Test Sync
```bash
# Start backend
npm start

# Logs should show:
# Starting ad sync from Binance { sellerId: '1135945063' }
# 📥 Fetched X ads from Binance
# ✅ Synced ad: 123456789
```

### 3. Verify Database
```sql
SELECT seller_id, ad_no, asset FROM seller_ads;
-- Should show seller's ads with seller_id = 1135945063
```

---

## Troubleshooting

### ❌ "Invalid API key"
- Verify `BINANCE_SELLER_API_KEY` is correct
- Check for extra spaces in .env
- Regenerate key on Binance if needed

### ❌ "Permission denied"
- Check API key has **C2C Trading** permission
- Check IP whitelist (if enabled)
- Verify key is for a seller account (has ads)

### ❌ "No ads found"
- Seller account has no ads created on Binance
- Wrong API key (using buyer key instead of seller key)
- Check seller account on Binance directly

### ❌ "Backend won't start"
- Missing `BINANCE_SELLER_API_KEY` in .env
- Invalid .env format
- Restart with: `npm start`

---

## Security Best Practices

✅ **DO:**
- Use different keys for buyer and seller
- Keep keys in .env (never in code)
- Restrict IP access on Binance if possible
- Use Read-only permission where possible
- Regenerate keys if compromised

❌ **DON'T:**
- Commit .env to git
- Share API keys
- Use production keys for testing
- Log API keys
- Store keys in plain text files

---

## API Endpoints Using Seller Keys

When you sync ads:

1. **`/sapi/v1/c2c/ads/searchAdsByPage`** - Get seller's ads
2. **`/sapi/v1/c2c/ads/queryAd`** - Get specific ad details
3. **`/sapi/v1/c2c/orderMatch/listOrders`** - Get seller's orders

All these endpoints use `BINANCE_SELLER_API_KEY` credentials.

---

## Multi-Account Support

If you have multiple seller accounts:

### Option 1: Separate Environments
Create different .env files:
```
.env.seller1 → BINANCE_SELLER_API_KEY=key1
.env.seller2 → BINANCE_SELLER_API_KEY=key2
```

Start with: `node -r dotenv/config -o .env.seller1 start`

### Option 2: Environment Variable
```bash
export BINANCE_SELLER_API_KEY=seller2_key
npm start
```

---

## Complete .env Example

```env
# ==========================================
# BUYER SYSTEM
# ==========================================
BINANCE_API_KEY=buyer_api_key_here
BINANCE_SECRET_KEY=buyer_secret_key_here

# ==========================================
# SELLER SYSTEM
# ==========================================
BINANCE_SELLER_API_KEY=seller_api_key_here
BINANCE_SELLER_SECRET_KEY=seller_secret_key_here
SELLER_ID=1135945063
SELLER_NAME=AGPSS GLOBAL PRIVATE LIMITED

# ==========================================
# DATABASE
# ==========================================
DB_HOST=localhost
DB_PORT=3306
DB_USER=agpssvda1_p2p_user
DB_PASS=Createmy@123456
DB_NAME=agpssvda1_p2p

# ==========================================
# SELLER CONFIGURATION
# ==========================================
SELLER_MODE=true
SELLER_ORDER_POLL_INTERVAL=5000
SELLER_LIVENESS_TIMEOUT=600000
SELLER_DOCUMENT_TIMEOUT=900000
SELLER_OTP_TIMEOUT=300000
SELLER_PAYMENT_TIMEOUT=86400000
```

---

## Next Steps

1. ✅ Add `BINANCE_SELLER_API_KEY` to .env
2. ✅ Add `BINANCE_SELLER_SECRET_KEY` to .env
3. ✅ Restart backend: `npm start`
4. ✅ Click "Sync from Binance" in UI
5. ✅ Verify ads appear with seller_id = 1135945063

---

**Seller API keys setup complete!** 🎉
