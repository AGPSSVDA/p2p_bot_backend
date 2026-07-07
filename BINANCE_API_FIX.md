# Binance API Key Error Fix 🔧

## Error Message
```
{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}
```

This means your API key is either:
1. Invalid/Expired
2. Wrong permissions
3. IP not whitelisted

---

## Fix Step 1: Check API Key Status

### On Binance Website
1. Go to: https://www.binance.com/en/account/api-management
2. Check if your API key shows any warnings
3. Check the **Status** column:
   - ✅ Should show "Active"
   - ❌ If "Restricted" or "Disabled" → Enable it

### If Expired
- Delete old key
- Create new key
- Add to .env

---

## Fix Step 2: Verify API Permissions

### What Permissions You Need
✅ **Spot & Margin Trading** - For C2C endpoints
✅ **Read** - To fetch order/ad information
❌ **Don't need**: Withdraw, Transfer, etc.

### How to Check
1. Go to: https://www.binance.com/en/account/api-management
2. Click on your API key
3. Check under **Restrictions**:
   - [ ] **Spot & Margin Trading** - MUST BE ENABLED
   - [ ] **Read** - MUST BE ENABLED
   - [ ] IP Whitelist - Your server IP added

---

## Fix Step 3: IP Whitelist

### Add Your IP to Whitelist

1. Go to: https://www.binance.com/en/account/api-management
2. Click on your API key
3. Under **Whitelist IPs**, add:
   ```
   127.0.0.1         (for localhost development)
   YOUR_SERVER_IP    (for production)
   ```

### Find Your Public IP
```bash
# Linux/Mac
curl https://api.ipify.org

# Windows PowerShell
(Invoke-WebRequest -Uri "https://api.ipify.org").Content
```

### For Local Development
Add this to whitelist:
```
127.0.0.1
localhost
```

---

## Fix Step 4: Test API Key

### Test Command
```bash
# Replace with your actual API key
curl -s "https://api.binance.com/api/v3/account" \
  -H "X-MBX-APIKEY: YOUR_API_KEY" \
  | grep -o "balances"
```

### Expected Output
```
"balances"
```

### If You Get Error
```json
{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}
```

Then the key or permissions are wrong.

---

## Fix Step 5: Reset API Key (If Nothing Works)

### Delete and Create New Key

1. Go to: https://www.binance.com/en/account/api-management
2. Find your key
3. Click **Delete**
4. Confirm deletion
5. **Wait 5 minutes** (Binance takes time)
6. Click **Create API key**
7. Choose: **Spot & Margin Trading**
8. Name it: `P2P_BOT_KEY` (or any name)
9. Set Restrictions:
   - ✅ **Enable Spot & Margin Trading**
   - ✅ **Enable Read**
   - IP Whitelist: Add your IP
10. Generate key
11. **COPY the key immediately** (won't show again)
12. Update .env with new key

---

## Fix Step 6: Update .env

```env
# Replace with NEW key from Binance
BINANCE_API_KEY=new_api_key_here
BINANCE_SECRET_KEY=new_secret_key_here

# Also for seller if using separate account
BINANCE_SELLER_API_KEY=seller_api_key
BINANCE_SELLER_SECRET_KEY=seller_secret_key
```

---

## Fix Step 7: Restart Backend

```bash
# Stop current backend (Ctrl+C)

# Clear any cached connections
rm -rf node_modules/.cache

# Start fresh
npm start
```

---

## Troubleshooting Checklist

- [ ] API key is **Active** (not Disabled/Restricted)
- [ ] API key has **Spot & Margin Trading** enabled
- [ ] API key has **Read** enabled
- [ ] Your IP is in **IP Whitelist**
- [ ] You waited 5+ minutes after creating key
- [ ] .env has the correct API key
- [ ] .env has the correct Secret key
- [ ] No extra spaces in .env around keys
- [ ] Backend restarted after updating .env

---

## Common Issues

### ❌ "Invalid API-key"
- Key is wrong/expired
- Key was just created (wait 5 minutes)
- Wrong key pasted (copy again)

### ❌ "Invalid permissions"
- Spot & Margin Trading not enabled
- Read permission not enabled
- Contact Binance support if restricted

### ❌ "IP not allowed"
- Your IP not in whitelist
- Using VPN/Proxy (IP changed)
- Server IP changed

---

## For Development Mode (localhost)

Use this in .env if developing locally:

```env
# Localhost for testing
BINANCE_API_KEY=your_key_here
BINANCE_SECRET_KEY=your_secret_here

# Make sure on Binance you added to whitelist:
# - 127.0.0.1
# - Your actual public IP (from: https://api.ipify.org)
```

---

## For Production Mode

```env
# Production server IP
BINANCE_API_KEY=your_key_here
BINANCE_SECRET_KEY=your_secret_here

# Make sure on Binance you added to whitelist:
# - Your server's public IP
```

---

## Important Security Notes

⚠️ **NEVER**:
- Share API key in messages/emails
- Commit API key to GitHub
- Use same key for buyer AND seller
- Use old expired keys

✅ **DO**:
- Regenerate key if compromised
- Use separate keys for different accounts
- Restrict permissions to minimum needed
- Whitelist only necessary IPs

---

## Quick Checklist to Fix

1. [ ] Go to https://www.binance.com/en/account/api-management
2. [ ] Delete old API key
3. [ ] Create NEW API key with:
   - [ ] Spot & Margin Trading: ✅ Enabled
   - [ ] Read: ✅ Enabled
   - [ ] IP Whitelist: Add your IP
4. [ ] Copy NEW key and secret
5. [ ] Update .env with NEW key
6. [ ] Wait 5 minutes
7. [ ] Restart backend: `npm start`
8. [ ] Check logs: Should say "Binance clock synced"

---

## Still Getting Error?

Try this test:

```bash
node -e "
const axios = require('axios');
const key = process.env.BINANCE_API_KEY;
axios.get('https://api.binance.com/api/v3/account', {
  headers: { 'X-MBX-APIKEY': key }
}).then(r => console.log('✅ OK')).catch(e => console.log('❌', e.response?.data));
"
```

---

## Contact Binance Support

If you've done all steps and still getting error:

1. Open: https://www.binance.com/en/support
2. Create ticket
3. Include:
   - API key (last 8 chars only)
   - Error message
   - Steps you've tried

---

**The issue is 99% likely to be:** Your API key is expired or doesn't have Spot & Margin Trading permission.

**Solution: Create a NEW API key with proper permissions!** 🎉
