# Seller Sync Detailed Logging 📊

## Overview

Added comprehensive logging at every step of the seller ads sync process. Now you can see **exactly what's happening** when you sync ads from Binance.

---

## What Gets Logged

### 1. Sync Controller Logs
When you call `/api/seller/sync/ads`, you'll see:

```
🔵 [SELLER SYNC] Checking SELLER_ID: 1135945063
✅ [SELLER SYNC] SELLER_ID found: 1135945063
🔄 [SELLER SYNC] Starting ad sync from Binance...
📡 [SELLER SYNC] Calling getSellerAds()...
✅ [SELLER SYNC] getSellerAds() returned 3 ads
```

### 2. Binance Service Logs
When fetching ads from Binance:

```
📡 [SELLER BINANCE] Fetching ads from Binance... (page=1, rows=50)
📍 [SELLER BINANCE] Using API key: GK672Rmg2...
📍 [SELLER BINANCE] Using endpoint: /sapi/v1/c2c/ads/searchAdsByPage
🔐 [SELLER BINANCE] Query signed successfully
🌐 [SELLER BINANCE] Request URL: https://api.binance.com/sapi/v1/c2c/ads/...
✅ [SELLER BINANCE] Response received, status: 200
📦 [SELLER BINANCE] Parsed ads list, count: 3
📋 [SELLER BINANCE] Sample ad: { advNo: '123456789', asset: 'USDT', ... }
✅ [SELLER BINANCE] Fetched seller ads from Binance
```

### 3. Ad Processing Logs
For each ad being synced:

```
🔄 [SELLER SYNC] Processing 3 ads from Binance...
📋 [SELLER SYNC] Ads received: [
  { advNo: '123456789', asset: 'USDT', tradeType: 'BUY' },
  { advNo: '123456790', asset: 'BUSD', tradeType: 'BUY' }
]

📌 [SELLER SYNC] Processing ad: 123456789
   - Asset: USDT, TradeType: BUY, Price: 83.5
   💾 Saving ad to database for seller: 1135945063...
   ✅ Successfully synced ad: 123456789

📌 [SELLER SYNC] Processing ad: 123456790
   - Asset: BUSD, TradeType: BUY, Price: 82.8
   💾 Saving ad to database for seller: 1135945063...
   ✅ Successfully synced ad: 123456790

⏭️  Skipped non-BUY ad (if any)
```

### 4. Completion Logs
```
🎉 [SELLER SYNC] Sync completed: 2 synced, 0 skipped, 3 total
📤 [SELLER SYNC] Sending response with 2 ads
✅ [SELLER SYNC] Sync completed: 2/3 ads synced
```

### 5. Error Logs
If something fails:

```
❌ [SELLER SYNC] Error: Invalid API-key, IP, or permissions for action
📍 [SELLER SYNC] Error Stack: Error: Request failed with status code 400...
❌ [SELLER SYNC] Sync error: Invalid API-key, IP, or permissions for action

--- OR ---

❌ [SELLER BINANCE] Binance API error: Invalid API-key, IP, or permissions for action
❌ [SELLER STATUS] Binance API error: Invalid API-key, IP, or permissions for action
```

---

## Logging Locations

### Terminal Output (Console Logs)
- **Real-time**: See logs as they happen
- **Color-coded**: 🔵 info, ✅ success, ❌ error, 📡 request
- **Visible immediately**: No buffering

### Log File
- Located in application logs
- Prefixed with: `[SELLER SYNC]`, `[SELLER BINANCE]`, `[SELLER STATUS]`
- Includes error stacks for debugging

---

## Debug Checklist - Use These Logs to Check

### ✅ API Key Status
```
📍 [SELLER BINANCE] Using API key: GK672Rmg2...
```
- If it shows "NOT SET" → SELLER_API_KEY not in .env

### ✅ Binance Connection
```
✅ [SELLER BINANCE] Response received, status: 200
```
- If status is 400, 401, 403 → API key issue
- If timeout → Network issue

### ✅ Ads Fetched
```
📦 [SELLER BINANCE] Parsed ads list, count: 3
```
- If count is 0 → No ads on Binance for this seller
- If count > 0 but sample shows wrong data → API response parsing issue

### ✅ Database Save
```
💾 Saving ad to database for seller: 1135945063...
✅ Successfully synced ad: 123456789
```
- If fails → Database connection issue

### ✅ Final Count
```
🎉 [SELLER SYNC] Sync completed: 2 synced, 0 skipped, 3 total
```
- If synced < total → Some ads failed (check error logs)

---

## Running a Test Sync

### Terminal Steps

1. **Start backend and watch logs**:
   ```bash
   npm start 2>&1 | tee sync.log
   ```

2. **In another terminal, trigger sync**:
   ```bash
   curl -X POST http://localhost:5000/api/seller/sync/ads \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json"
   ```

3. **Watch the terminal** for detailed logging at each step

### What You'll See

```
🔵 [SELLER SYNC] Checking SELLER_ID: 1135945063
✅ [SELLER SYNC] SELLER_ID found: 1135945063
🔄 [SELLER SYNC] Starting ad sync from Binance...
📡 [SELLER SYNC] Calling getSellerAds()...
📡 [SELLER BINANCE] Fetching ads from Binance... (page=1, rows=50)
✅ [SELLER BINANCE] Response received, status: 200
✅ [SELLER SYNC] getSellerAds() returned 3 ads
📋 [SELLER SYNC] Ads received: [...]
... (processing each ad)
🎉 [SELLER SYNC] Sync completed: 2 synced, 0 skipped, 3 total
📤 [SELLER SYNC] Sending response with 2 ads
```

---

## Troubleshooting Using Logs

### Issue: "No ads syncing"

**Check logs for**:
```
📦 [SELLER BINANCE] Parsed ads list, count: 0
```

**Fix**: Check Binance account has ads created

---

### Issue: "API key error"

**Check logs for**:
```
❌ [SELLER BINANCE] Binance API error: Invalid API-key, IP, or permissions
```

**Fix**: 
1. Regenerate API key on Binance
2. Enable "Spot & Margin Trading" permission
3. Add IP to whitelist
4. Update .env and restart

---

### Issue: "Database error"

**Check logs for**:
```
❌ Failed to sync ad 123456789: Connection refused
```

**Fix**:
1. Check MySQL is running: `net start MySQL80`
2. Check .env DB credentials
3. Run migration: `node run-migration.js`

---

### Issue: "Wrong seller_id"

**Check logs for**:
```
🔵 [SELLER SYNC] Checking SELLER_ID: 1135945063
```

Should show your merchant ID (1135945063)

**Fix**: Verify SELLER_ID in .env

---

## Log Format Reference

### Log Prefixes
| Prefix | Meaning |
|--------|---------|
| 🔵 | Info (informational message) |
| ✅ | Success (operation succeeded) |
| ❌ | Error (operation failed) |
| 🔄 | Processing (in progress) |
| 📡 | Network (API call) |
| 💾 | Database (save operation) |
| 📦 | Data (received/parsed) |
| 📋 | Details (detailed info) |
| 🎉 | Complete (sync finished) |
| 🌐 | URL/Endpoint |
| 🔐 | Security/Auth |
| ⏭️  | Skipped |
| 📍 | Location/Config |

---

## Enable/Disable Verbose Logging

### Current State
All logs are **enabled** by default.

### To Disable Console Logs (Keep file logs)
Remove or comment out `console.log()` calls in:
- `src/seller/controllers/sellerSyncController.js`
- `src/services/sellerBinanceService.js`

### To Enable Full Debug Mode
Set in `.env`:
```env
LOG_LEVEL=debug
SELLER_DEBUG=true
```

---

## Sample Complete Sync Log

```
[23:36:10] 🔵 [SELLER SYNC] Checking SELLER_ID: 1135945063
[23:36:10] ✅ [SELLER SYNC] SELLER_ID found: 1135945063
[23:36:10] 🔄 [SELLER SYNC] Starting ad sync from Binance...
[23:36:10] 📡 [SELLER SYNC] Calling getSellerAds()...
[23:36:10] 📡 [SELLER BINANCE] Fetching ads from Binance... (page=1, rows=50)
[23:36:10] 📍 [SELLER BINANCE] Using API key: GK672Rmg2...
[23:36:10] 📍 [SELLER BINANCE] Using endpoint: /sapi/v1/c2c/ads/searchAdsByPage
[23:36:10] 🔐 [SELLER BINANCE] Query signed successfully
[23:36:10] 🌐 [SELLER BINANCE] Request URL: https://api.binance.com/sapi/v1/c2c/ads/...
[23:36:11] ✅ [SELLER BINANCE] Response received, status: 200
[23:36:11] 📦 [SELLER BINANCE] Parsed ads list, count: 2
[23:36:11] 📋 [SELLER BINANCE] Sample ad: {advNo:'123456789', asset:'USDT', price:83.5}
[23:36:11] ✅ [SELLER SYNC] getSellerAds() returned 2 ads
[23:36:11] 🔄 [SELLER SYNC] Processing 2 ads from Binance...
[23:36:11] 📋 [SELLER SYNC] Ads received: [{advNo:'123456789', asset:'USDT', tradeType:'BUY'}]
[23:36:11] 📌 [SELLER SYNC] Processing ad: 123456789
[23:36:11]    - Asset: USDT, TradeType: BUY, Price: 83.5
[23:36:11]    💾 Saving ad to database for seller: 1135945063...
[23:36:11]    ✅ Successfully synced ad: 123456789
[23:36:12] 🎉 [SELLER SYNC] Sync completed: 1 synced, 0 skipped, 2 total
[23:36:12] 📤 [SELLER SYNC] Sending response with 1 ads
[23:36:12] ✅ [SELLER SYNC] Sync completed: 1/2 ads synced
```

---

## Next Steps

1. **Restart backend** to apply logging changes
2. **Trigger sync** via `/api/seller/sync/ads`
3. **Watch terminal output** for detailed logs
4. **Use logs to debug** any issues

---

**Now you can see exactly what's happening at every step!** 🎉
