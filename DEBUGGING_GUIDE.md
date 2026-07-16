# Debugging Guide - Eligibility Sync Issues

## How to Debug

### Step 1: Open Browser Console
1. Open Admin Dashboard
2. Press `F12` to open Developer Tools
3. Go to **Console** tab
4. Keep it open while testing

### Step 2: Edit an Ad
1. Click Edit on any ad
2. **Look at console** - should show:
   ```
   🔄 [FRONTEND] Starting save...
   📋 Rules to save:
   { eligibility: { ... }, methods: { ... } }
   ```

### Step 3: Update Eligibility
1. Check "Min 30-Day Trades" checkbox
2. Enter value "20" in the input field
3. **Check console** - input should trigger onChange

### Step 4: Click Save
1. Click the Save button
2. **Watch console for these logs**:
   ```
   🔄 [FRONTEND] Step 1: Syncing eligibility to Binance...
   🔄 [FRONTEND] Step 2: Saving to database...
   ✅ [FRONTEND] Database save successful
   ```

---

## Backend Logging

### Check Terminal Logs

When you save, the **terminal where backend is running** should show:

```
🔄 [SYNC] Starting eligibility sync to Binance
   Seller ID: 1135945063
   Ad No: 13900814235866066944

📊 [SYNC] Step 1: Fetching ad rules from database...
   ✅ Ad rules found
   Rules: { min_30day_trades: 20, min_30day_trades_enabled: true, ... }

🔨 [SYNC] Step 2: Building Binance payload...
   Checking criteria...
   ✅ Min 30-day trades: 20
   ✅ Min completion rate: 98
   ✅ Min registered days: 100
   ... etc

📦 [SYNC] Final Binance Payload:
{
  advNo: "13900814235866066944",
  userTradeCountMin: 20,
  userTradeCountFilterTime: 30,
  ...
}

🌐 [SYNC] Step 3: Calling Binance API /sapi/v1/c2c/ads/update...
   Endpoint: POST /sapi/v1/c2c/ads/update
   Ad No: 13900814235866066944

📡 [BINANCE API] Calling updateAd
   Ad No: 13900814235866066944
   Fields to update: userTradeCountMin, userTradeCountFilterTime, ...
   Full payload: { advNo: "...", ... }
   Sending POST request to: /sapi/v1/c2c/ads/update

   ✅ Binance API Response received
   Status: 200
   Data: { code: "0", success: true, message: "success" }

📡 [SYNC] Binance Response:
{ code: "0", success: true, message: "success" }

✔️  [SYNC] Step 4: Validating Binance response...
   Response received. Checking status...
   - result.code: 0
   - result.success: true
   - result.message: success
   ✅ Binance response valid - Update successful!

✅ [SYNC] SUCCESS - Ad eligibility synced to Binance
```

---

## Troubleshooting

### Issue 1: Frontend logs show values are empty

**Console shows**:
```
📋 Rules to save:
{
  eligibility: {
    min30dayTrades: { enabled: true, value: 0 },
    min30dayCompletionRate: { enabled: true, value: 0 },
    ...
  }
}
```

**Problem**: Values are 0 instead of the number you entered

**Solution**:
1. Check if input field is disabled
2. Try clicking checkbox AFTER entering value
3. Check if input onChange is firing (add more console logs)

### Issue 2: Backend logs show "disabled or no value"

**Terminal shows**:
```
🔨 [SYNC] Step 2: Building Binance payload...
   ❌ Min 30-day trades: disabled or no value
   ❌ Min completion rate: disabled or no value
```

**Problem**: Backend received enabled=true but value=0

**Solution**:
1. Frontend is not sending values properly
2. Check the `updateEligibility` function
3. Verify input onChange is working

### Issue 3: Binance API returns error

**Terminal shows**:
```
📡 [SYNC] Binance Response:
{ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }

❌ [SYNC] ERROR - Binance returned error: Invalid API-key, IP, or permissions
```

**Problem**: API key doesn't have permissions

**Solution**:
1. Go to Binance API Management
2. Enable "P2P Trading" permission
3. Save and restart backend

### Issue 4: Input field shows empty even when value is set

**Problem**: `getCriterionValue()` returns empty string for 0

**Why**: Line 133: `return criterion.value || ''` converts 0 to ''

**Fix**: Need to change getCriterionValue to handle 0 properly

```javascript
const getCriterionValue = (criterion: any) => {
  if (!criterion) return '';
  if (typeof criterion === 'object' && 'value' in criterion) {
    // Handle 0 as a valid value
    return criterion.value !== undefined && criterion.value !== null ? criterion.value : '';
  }
  return criterion;
};
```

---

## Complete Flow with Logging

### Frontend Side

1. **Admin checks checkbox**
   ```
   onCheckedChange fires
   → updateEligibility called
   → rules.eligibility.min30dayTrades = { enabled: true, value: 0 }
   ```

2. **Admin enters value "20"**
   ```
   onChange fires
   → updateEligibility called
   → rules.eligibility.min30dayTrades = { enabled: true, value: 20 }
   ```

3. **Admin clicks Save**
   ```
   handleSave called
   → console.log shows entire rules object
   → Check if value is in the object!
   ```

### Backend Side

1. **Sync endpoint called**
   ```
   POST /seller/ads/{adNo}/sync-eligibility
   → Logs: "Starting eligibility sync to Binance"
   ```

2. **Database fetch**
   ```
   getAdRules(adNo)
   → Logs: "Ad rules found" or "Ad rules not found"
   → Shows: min_30day_trades, min_30day_trades_enabled, etc.
   ```

3. **Payload building**
   ```
   For each criterion:
   - if (enabled && value) → include in payload
   - Logs: "✅ Criterion: VALUE" or "❌ Criterion: disabled or no value"
   ```

4. **Binance API call**
   ```
   axios.post(/sapi/v1/c2c/ads/update)
   → Logs: Payload sent
   → Logs: Response received
   ```

5. **Response validation**
   ```
   if (code === '0' && success === true)
   → Logs: "✅ SUCCESS"
   else
   → Logs: "❌ ERROR: {message}"
   ```

---

## What to Look For

### ✅ If Everything Works

**Frontend Console**:
```
🔄 [FRONTEND] Starting save...
📋 Rules to save: { eligibility: { min30dayTrades: { enabled: true, value: 20 }, ... } }
🔄 [FRONTEND] Step 1: Syncing eligibility to Binance...
✅ [FRONTEND] Binance sync successful
🔄 [FRONTEND] Step 2: Saving to database...
✅ [FRONTEND] Database save successful
```

**Backend Terminal**:
```
🔄 [SYNC] Starting eligibility sync to Binance
   Seller ID: 1135945063
   Ad No: 13900814235866066944

📊 [SYNC] Step 1: Fetching ad rules from database...
   ✅ Ad rules found

🔨 [SYNC] Step 2: Building Binance payload...
   ✅ Min 30-day trades: 20
   ✅ Min completion rate: 98
   (etc for all enabled criteria)

🌐 [SYNC] Step 3: Calling Binance API...
   Sending POST request...

   ✅ Binance API Response received
   Status: 200
   Data: { code: "0", success: true }

✔️  [SYNC] Step 4: Validating response...
   ✅ Binance response valid

✅ [SYNC] SUCCESS - Ad eligibility synced to Binance
```

---

## Next Steps

1. **Run the flow and watch BOTH console and terminal**
2. **Screenshot the logs** if there's an error
3. **Look for first ❌ in the logs** - that's where it fails
4. **Based on where it fails, apply the fix**

---

## Common Fixes

### Fix 1: getCriterionValue returning '' for 0

```javascript
const getCriterionValue = (criterion: any) => {
  if (!criterion) return '';
  if (typeof criterion === 'object' && 'value' in criterion) {
    // Don't use || operator with 0, check explicitly
    return criterion.value !== undefined && criterion.value !== null ? criterion.value : '';
  }
  return criterion;
};
```

### Fix 2: Input not updating value

Check that `onChange` handler is updating the correct field:
```javascript
onChange={(e) =>
  updateEligibility('min30dayTrades', {
    enabled: getCriterionEnabled(rules.eligibility.min30dayTrades),
    value: parseInt(e.target.value) || 0  // Make sure this is working
  })
}
```

### Fix 3: Checkbox not working

Check that `onCheckedChange` is updating both enabled and value:
```javascript
onCheckedChange={(checked) => {
  updateEligibility('min30dayTrades', {
    enabled: checked,
    value: checked ? 0 : ''  // Set 0 when enabling, clear when disabling
  })
}
}
```

---

## Summary

✅ **Now you have detailed logging at every step**
✅ **Watch frontend console AND backend terminal together**
✅ **First ❌ in the logs tells you exactly where to fix**

Just follow the logs and you'll find the issue!
