# Seller Ads Sync Setup Guide

## Overview
This guide explains how to sync seller ads from Binance to your dashboard.

---

## Step 1: Backend Configuration

### Binance API Key Permissions
Your Binance API key must have:
- ✅ **C2C Trading** permission
- ✅ **Read** access to own ads

If you don't have these permissions:
1. Go to https://www.binance.com/en/account/api-management
2. Edit your API key
3. Enable **C2C Trading** permission
4. Save and wait 2-3 minutes for changes to take effect

---

## Step 2: Restart Backend

After fixing permissions, restart the backend:

```bash
npm start
```

You should see:
```
✅ Database schema initialized.
✅ MySQL connected successfully.
✅ 🌐 API server listening on http://localhost:5000
```

---

## Step 3: Frontend Testing

### Option A: Use the "Sync from Binance" Button

1. **Open your frontend**: http://localhost:3000/seller/ads
2. **Click "Sync from Binance"** button (blue button at top-right)
3. **Wait for sync** to complete (spinner will show)
4. **Ads will appear** in the list once synced

### Option B: Check Backend Logs

While syncing, you should see logs like:

```
[HH:MM:SS] info: [SELLER API] POST /sync/ads
[HH:MM:SS] info: Starting ad sync from Binance
[HH:MM:SS] info: 📥 Fetched 3 ads from Binance
[HH:MM:SS] info: ✅ Synced ad: 123456789
[HH:MM:SS] info: ✅ Synced ad: 123456790
[HH:MM:SS] info: ✅ Sync completed: 2/3 ads
```

---

## Step 4: Verify Ads Display

Once synced, each ad shows:

- **Ad Number** (advNo from Binance)
- **Asset** (USDT, BUSD, etc.)
- **Fiat Currency** (INR, USD, etc.)
- **Price Rate**
- **Min/Max Order Amounts**
- **Active Status** (badge showing Active/Inactive)
- **Verification Methods** configured (Liveness, Documents, Full)

---

## Troubleshooting

### ❌ "No ads found on Binance"

**Possible causes:**
1. You have no seller ads created on Binance
2. Your API key doesn't have C2C permission
3. Your API IP whitelist doesn't include your server IP

**Solution:**
1. Create a seller ad on Binance directly: https://www.binance.com/en/c2c/ads/post
2. Check API permissions in API Management
3. If self-hosted: Add your server IP to API whitelist

---

### ❌ "Cannot connect to Binance API"

**Possible causes:**
1. API key expired or invalid
2. API Secret is wrong
3. Server IP not whitelisted
4. Network connectivity issue

**Solution:**
- Check `.env` for correct `BINANCE_API_KEY` and `BINANCE_API_SECRET`
- Test API key with curl:
  ```bash
  curl -X GET "https://api.binance.com/api/v3/account" \
    -H "X-MBX-APIKEY: YOUR_API_KEY"
  ```

---

### ❌ "Sync button doesn't work"

**Check browser console:**
1. Open DevTools (F12)
2. Go to Console tab
3. Look for error messages
4. Check Network tab for failed requests

**Check backend logs:**
```bash
# Kill current backend and start with debug
DEBUG=* npm start
```

---

## API Endpoints

### Sync Ads from Binance
```bash
POST /api/seller/sync/ads
Header: Authorization: Bearer {JWT_TOKEN}
```

Response:
```json
{
  "success": true,
  "data": {
    "synced": 2,
    "total": 3,
    "ads": [
      {
        "advNo": "123456789",
        "asset": "USDT",
        "fiat": "INR",
        "price": 83.5,
        "minAmount": 1000,
        "maxAmount": 100000
      }
    ],
    "message": "Successfully synced 2 ads"
  }
}
```

### Check Sync Status
```bash
GET /api/seller/sync/status
Header: Authorization: Bearer {JWT_TOKEN}
```

Response:
```json
{
  "success": true,
  "data": {
    "binanceConnected": true,
    "adCount": 3,
    "lastSync": "2026-07-04T22:14:15.000Z",
    "message": "Binance API is connected"
  }
}
```

---

## How It Works

```
1. User clicks "Sync from Binance" button
   ↓
2. Frontend calls POST /api/seller/sync/ads
   ↓
3. Backend calls binanceService.getMyAds()
   ↓
4. Binance API returns seller's ads
   ↓
5. Backend filters for BUY ads (seller selling crypto)
   ↓
6. Backend stores ads in seller_ads table
   ↓
7. Frontend receives success response
   ↓
8. Frontend auto-refreshes ads list
   ↓
9. Seller ads now display in dashboard
```

---

## Database Schema

Synced ads are stored in `seller_ads` table:

```sql
SELECT * FROM seller_ads WHERE seller_id = 1;
```

Columns:
- `ad_no` - Binance ad number
- `ad_name` - Ad name
- `seller_id` - Your user ID
- `asset` - USDT, BUSD, etc.
- `fiat_unit` - INR, USD, etc.
- `price_rate` - Price per unit
- `min_order_amount` - Minimum order
- `max_order_amount` - Maximum order
- `is_active` - Active/Inactive status
- `created_at`, `updated_at` - Timestamps

---

## Next Steps

After syncing ads:

1. ✅ View ads in dashboard
2. ✅ Edit verification rules for each ad (click "Edit Rules")
3. ✅ Configure eligibility criteria (11 rules)
4. ✅ Choose verification methods (Liveness/Documents/Full)
5. ✅ Enable/Disable ads as needed
6. ✅ Seller orders will be automatically verified using these rules

---

## Support

If you encounter issues:

1. **Check backend logs**: `npm start` output
2. **Check frontend console**: DevTools → Console tab
3. **Check database**: Verify ads in `seller_ads` table
4. **Test Binance API**: Use curl to test connectivity
5. **Verify permissions**: Check API key has C2C permission

---

**Ready to sync? Click "Sync from Binance" on /seller/ads page!**
