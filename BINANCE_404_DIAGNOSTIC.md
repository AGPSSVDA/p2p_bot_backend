# Binance 404 Error Diagnostic Guide 🔍

## Problem

All Binance P2P ads endpoints returning **404 - Not Found**:
- `/sapi/v1/c2c/ads/searchAdsByPage` ❌
- `/sapi/v1/c2c/user/ads/list` ❌
- `/sapi/v1/c2c/ads/list` ❌
- `/sapi/v1/c2c/user/advertisement/list` ❌

---

## Possible Causes (In Order)

### 1. ❌ API Key Does NOT Have C2C Permission

**Symptom**: Getting 404 on all endpoints
**Fix**: Go to https://www.binance.com/en/account/api-management

Check API Key Restrictions:
- ✅ Enable: **Spot & Margin Trading**
- ✅ Enable: **C2C Trading** (CRITICAL!)
- ✅ Add IP to whitelist

**If C2C Trading is not available**:
This could mean:
- Your Binance account doesn't have C2C merchant status
- You need to apply: https://c2c.binance.com/en/merchantApplication
- Once approved, the C2C permission will appear in API settings

---

### 2. ❌ This Might Be a Merchant Account Feature

**What**: P2P/C2C APIs might only work for **Binance merchants**, not regular accounts

**Check if you have merchant status**:
1. Go to: https://www.binance.com/en/c2c/trade
2. Look for "Create Offer" or "Merchant Dashboard"
3. If you see "Apply for Merchant" - you need to apply first

**If NOT a merchant**:
- Apply: https://c2c.binance.com/en/merchantApplication
- Wait for approval
- Then set up API key with C2C permission
- Then try again

---

### 3. ❌ API Key Restrictions

**Symptom**: Getting 401/403 error instead of 404
**Fix**: Make sure in API Management:
- IP Whitelist includes your server IP
- "Enable C2C Trading" is checked
- Key is not restricted to specific IPs that exclude you

---

### 4. ❌ Using Wrong API Key

**Check**: Verify you're using the CORRECT API key for the SELLER account

```bash
# Check which key is in .env
grep BINANCE_SELLER_API_KEY .env
```

If wrong:
1. Generate new API key on correct Binance merchant account
2. Update `.env`:
   ```env
   BINANCE_SELLER_API_KEY=correct_key_here
   BINANCE_SELLER_SECRET_KEY=correct_secret_here
   ```
3. Restart backend

---

## Diagnostic Steps

### Step 1: Check API Key

```bash
grep BINANCE_SELLER .env
```

Should show:
```
BINANCE_SELLER_API_KEY=GK672Rmg2owQfQS1m83EoDnB0...
BINANCE_SELLER_SECRET_KEY=zsPJZ89x6Px7oqC3otfdRu7H...
```

### Step 2: Verify Merchant Status

Go to: https://www.binance.com/en/c2c/trade

If you see **"Apply for Merchant"** - you MUST apply first!

### Step 3: Check API Permissions

Go to: https://www.binance.com/en/account/api-management

Verify your seller API key has:
- ✅ **C2C Trading** - ENABLED
- ✅ **Spot & Margin Trading** - ENABLED
- ✅ **IP Whitelist** - includes your server IP

### Step 4: Test with cURL

```bash
# Replace API_KEY with your actual key
curl -X POST "https://api.binance.com/sapi/v1/c2c/ads/searchAdsByPage" \
  -H "X-MBX-APIKEY: API_KEY" \
  -d "page=1&rows=50"
```

**If 404**: The endpoint is not available
**If 200**: The endpoint works with this API key

---

## Real Solution

Since all P2P endpoints return 404, this likely means:

1. **Your Binance account is not a merchant** 
   - You MUST apply here: https://c2c.binance.com/en/merchantApplication
   - Wait for approval
   - Then the P2P APIs become available

2. **OR** your API key doesn't have the right permissions
   - Delete old key
   - Create new key with **C2C Trading** enabled
   - Add IP to whitelist

3. **OR** Binance changed the endpoint
   - The code now tries 3 endpoints automatically
   - If all fail, there's no working endpoint available

---

## What to Do NOW

### Option A: Check Merchant Status (5 minutes)
1. Go to https://www.binance.com/en/c2c/trade
2. Look for "Create Offer" button
3. If "Apply for Merchant" appears:
   - Click apply
   - Wait for approval (usually 1-2 days)
   - Then try sync again

### Option B: Regenerate API Key (10 minutes)
1. Go to https://www.binance.com/en/account/api-management
2. Delete old seller API key
3. Create NEW key:
   - ✅ Enable **C2C Trading** (critical)
   - ✅ Enable **Spot & Margin Trading**
   - Add IP to whitelist
4. Copy new key and secret
5. Update `.env`:
   ```env
   BINANCE_SELLER_API_KEY=new_key
   BINANCE_SELLER_SECRET_KEY=new_secret
   ```
6. Restart backend and try sync

### Option C: Both Above
Do Option A (check merchant) + Option B (new key with C2C permission)

---

## Updated Code

The seller service now:
1. ✅ Tries multiple endpoints automatically
2. ✅ Logs which endpoint worked
3. ✅ Distinguishes between 404 (endpoint not available) and 401/403 (permission issue)
4. ✅ Gives clear error messages

When you restart backend, you'll see:

```
🔄 [SELLER BINANCE] Trying endpoint: /sapi/v1/c2c/ads/searchAdsByPage
❌ [SELLER BINANCE] Endpoint failed - /sapi/v1/c2c/ads/searchAdsByPage (Status: 404)

🔄 [SELLER BINANCE] Trying endpoint: /sapi/v2/c2c/ads/list
❌ [SELLER BINANCE] Endpoint failed - /sapi/v2/c2c/ads/list (Status: 404)

🔄 [SELLER BINANCE] Trying endpoint: /sapi/v1/c2c/user/ads/list
❌ [SELLER BINANCE] Endpoint failed - /sapi/v1/c2c/user/ads/list (Status: 404)

❌ [SELLER BINANCE] All endpoints exhausted - no working endpoint found
❌ [SELLER SYNC] Error: All P2P ad endpoints returned 404...
```

---

## Summary

**Most Likely Cause**: Your Binance account is NOT a merchant account

**Fix**: Apply for merchant status at https://c2c.binance.com/en/merchantApplication

Once approved, the P2P APIs will work and syncing will succeed!

---

## Questions?

1. **Do you have merchant status?** Check https://www.binance.com/en/c2c/trade
2. **Does your API key have C2C Trading?** Check https://www.binance.com/en/account/api-management
3. **Have you added IP to whitelist?** Add your server IP in API settings

If all answers are yes and still getting 404:
- Binance may have changed the endpoint
- Try asking Binance support which P2P endpoint to use
- Reference: https://binance-docs.github.io/apidocs/#c2c-user-trade-api
