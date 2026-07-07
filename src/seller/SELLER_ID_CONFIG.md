# Seller ID Configuration Guide

## Overview

Your system now uses **SELLER_ID from .env** (the Binance P2P merchant ID) instead of the database user ID for all seller-related operations.

---

## Configuration

### In .env File
```
SELLER_ID=1135945063
SELLER_NAME=AGPSS GLOBAL PRIVATE LIMITED
```

This is your **Binance P2P Merchant ID**, not your user database ID.

---

## How It Works

### Before (Database User ID)
```
sellerId = req.user.id    // ❌ Database user ID (1, 2, 3, etc.)
```

### After (Binance Merchant ID)
```
sellerId = getSellerIdFromRequest(req)  // ✅ Uses SELLER_ID from .env
```

---

## Updated Files

All seller controllers now use the centralized helper function:

1. ✅ `sellerSyncController.js` - Sync ads from Binance
2. ✅ `sellerDashboardController.js` - Dashboard data
3. ✅ `sellerAdsController.js` - Ad management
4. ✅ `sellerOrdersController.js` - Order management

### Helper Function Location
```
src/seller/utils/sellerUtils.js
```

```javascript
function getSellerIdFromRequest(req) {
  // Priority: .env SELLER_ID > req.user.id
  const sellerId = process.env.SELLER_ID || (req?.user?.id);
  return sellerId;
}
```

---

## Database Schema

The `seller_ads` and `seller_orders` tables now correctly store and query using your Binance merchant ID:

```sql
-- Get your ads
SELECT * FROM seller_ads 
WHERE seller_id = '1135945063';

-- Get your orders
SELECT * FROM seller_orders 
WHERE seller_id = '1135945063';
```

---

## What This Means

### ✅ Seller Ads Sync
- Fetches ads for **Binance merchant ID**: 1135945063
- Stores in database with correct seller_id
- Dashboard shows only your ads

### ✅ Seller Orders
- Tracks orders for **your specific Binance account**
- Not confused with other sellers' orders
- Verification rules apply per your ads

### ✅ Multi-Seller Ready
- If you have multiple Binance accounts, change SELLER_ID in .env
- Each seller ID gets its own ads, orders, and rules
- Completely isolated per seller

---

## Testing

### 1. Verify Configuration
```bash
grep SELLER_ID .env
# Output: SELLER_ID=1135945063
```

### 2. Sync Ads
Click "Sync from Binance" button in `/seller/ads` page.

Backend logs should show:
```
Starting ad sync from Binance { sellerId: '1135945063' }
📥 Fetched 3 ads from Binance
✅ Synced ad: 123456789
```

### 3. Check Database
```sql
SELECT seller_id, ad_no, asset FROM seller_ads;
```

Should show:
```
seller_id          | ad_no      | asset
1135945063        | 123456789 | USDT
1135945063        | 123456790 | USDT
```

---

## Common Issues

### ❌ "SELLER_ID not configured in .env"
- Make sure `.env` file has `SELLER_ID=1135945063`
- Restart backend after adding to .env
- Check with: `grep SELLER_ID .env`

### ❌ Ads not syncing
- Verify SELLER_ID is correct (your Binance merchant ID)
- Check Binance API key permissions
- Check backend logs for error details

### ❌ Seeing ads from other sellers
- Verify SELLER_ID in .env is yours
- Check database: `SELECT DISTINCT seller_id FROM seller_ads;`
- If wrong ID exists, you may have synced with wrong account

---

## Migration Guide

If you were testing with different SELLER_ID:

### 1. Update .env
```
SELLER_ID=1135945063
```

### 2. Restart Backend
```bash
npm start
```

### 3. Re-sync Ads
Click "Sync from Binance" to fetch with correct seller ID

### 4. (Optional) Clean Old Data
```sql
-- If you had ads with wrong seller_id:
DELETE FROM seller_ads WHERE seller_id != '1135945063';
DELETE FROM seller_orders WHERE seller_id != '1135945063';
DELETE FROM seller_ad_rules WHERE seller_id != '1135945063';
```

---

## Architecture

```
.env: SELLER_ID=1135945063
         ↓
getSellerIdFromRequest(req)
         ↓
Used in ALL seller controllers
         ↓
Database queries filtered by seller_id
         ↓
Only YOUR ads/orders/rules shown
```

---

## Next Steps

1. ✅ Verify SELLER_ID in .env
2. ✅ Restart backend
3. ✅ Click "Sync from Binance"
4. ✅ Verify ads appear with correct seller_id
5. ✅ Edit ad rules
6. ✅ Start processing orders

---

**Status: ✅ SELLER_ID configuration complete**

All seller operations now use your Binance merchant ID (1135945063) for correct data isolation.
