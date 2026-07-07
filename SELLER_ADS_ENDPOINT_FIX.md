# Seller Ads Endpoint Fix 🔧

## Problem

Getting `404 - Not Found` error when trying to fetch seller ads from Binance.

```
❌ Error: getSellerAds:1 failed after 3 retries: Request failed with status code 404 
   body={"error":"Not Found","path":"/sapi/v1/c2c/ads/searchAdsByPage",...}
```

**Cause**: The endpoint `/sapi/v1/c2c/ads/searchAdsByPage` doesn't exist for seller accounts (it's a 404).

---

## Solution: Use Configurable Endpoint

I've updated the code to support **multiple endpoint variations** via environment variable.

### Updated Files

1. **`src/config/sellerBinanceConfig.js`**
   - Now uses environment variable `BINANCE_SELLER_ADS_ENDPOINT`
   - Defaults to `/sapi/v1/c2c/user/ads/list` (recommended for v7.4)

2. **`.env`**
   - Added: `BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/ads/list`
   - Easy to change if Binance endpoint varies

---

## Endpoint Options to Try

If you still get 404 error, try different endpoints in `.env`:

### Option 1 (Recommended for v7.4)
```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/ads/list
```

### Option 2 (Alternative endpoint)
```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/ads/searchAdsByPage
```

### Option 3 (Another variant)
```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/ads/list
```

### Option 4 (If using different API version)
```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/advertisement/list
```

---

## How to Test

### 1. Update `.env`
```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/ads/list
```

### 2. Restart Backend
```bash
npm start
```

### 3. Trigger Sync
```bash
curl -X POST http://localhost:5000/api/seller/sync/ads \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 4. Check Logs
Look for:
- ✅ `Response received, status: 200` = SUCCESS ✅
- ❌ `Response received, status: 404` = Try next endpoint
- ❌ `Response received, status: 400` = API key issue

---

## Which Endpoint Works?

Test each endpoint by checking the logs:

```
📍 [SELLER BINANCE] Using endpoint: /sapi/v1/c2c/user/ads/list
🌐 [SELLER BINANCE] Request URL: https://api.binance.com/sapi/v1/c2c/user/ads/list?...
✅ [SELLER BINANCE] Response received, status: 200  ← SUCCESS!
```

If status is 200, you found the correct endpoint!

---

## Common Issues

### Issue 1: Still getting 404
**Solution**: Try the next endpoint option above

### Issue 2: Getting 401 or 400
**Solution**: API key issue (not endpoint issue)
- Check BINANCE_SELLER_API_KEY is correct
- Verify "Spot & Margin Trading" permission
- Check IP whitelist

### Issue 3: Getting 403 Forbidden
**Solution**: Permission issue
- Check API key has C2C Trading enabled
- May need different endpoint permission

---

## API Version Context

Different Binance API versions have different endpoint names:

- **v7.4**: May use `/sapi/v1/c2c/user/ads/list`
- **v7.2**: May use `/sapi/v1/c2c/ads/searchAdsByPage`
- **Other**: May vary

Since Binance frequently updates APIs, the environment variable lets you quickly switch without redeploying code.

---

## Quick Diagnostic

Run this to see which endpoint is being used:

```bash
grep -r "BINANCE_SELLER_ADS_ENDPOINT" .env
# Shows: BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/ads/list
```

Check backend logs:

```bash
npm start 2>&1 | grep "Using endpoint"
# Shows: 📍 [SELLER BINANCE] Using endpoint: /sapi/v1/c2c/user/ads/list
```

---

## Testing All Endpoints Programmatically

If you want to test all endpoints automatically:

```bash
# Test endpoint 1
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/user/ads/list npm start

# In another terminal
curl -X POST http://localhost:5000/api/seller/sync/ads \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check logs for status code
# If 404, try endpoint 2, etc.
```

---

## What Changed

### Before
```javascript
// Hard-coded endpoint, got 404
endpoints: {
  searchMyAds: '/sapi/v1/c2c/ads/searchAdsByPage',
}
```

### After
```javascript
// Configurable endpoint with fallback
endpoints: {
  searchMyAds: process.env.BINANCE_SELLER_ADS_ENDPOINT || '/sapi/v1/c2c/user/ads/list',
}
```

---

## Next Steps

1. ✅ Update `.env` with correct endpoint (see options above)
2. ✅ Restart backend: `npm start`
3. ✅ Trigger sync and check logs
4. ✅ If still 404, try next endpoint option
5. ✅ Once 200 status shows, you found the right endpoint!

---

**Pro Tip**: Once you find the working endpoint, keep it in `.env` for future runs. The environment variable makes it easy to swap without code changes.
