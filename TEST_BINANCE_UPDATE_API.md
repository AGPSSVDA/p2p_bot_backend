# Binance Update Ad API - Test Cases & Implementation Guide

**API Endpoint**: `POST /sapi/v1/c2c/ads/update`
**Version**: SAPI v7.4
**Auth**: HMAC SHA256 signature

## Required Fields

```
advNo (string) - Ad number to update (REQUIRED)
```

## Optional Eligibility Fields

```
userTradeCountMin (number)          - Min trades in filterTime
userTradeCountFilterTime (number)   - Days window (e.g., 30)
userTradeCompleteRateMin (number)   - Min completion % (0-100)
userTradeCompleteRateFilterTime     - Days window
buyerRegDaysLimit (number)          - Min registered days
userAllTradeCountMin (number)       - Min all trades
userAllTradeCountMax (number)       - Max all trades
userBuyTradeCountMin (number)       - Min buy trades
userBuyTradeCountMax (number)       - Max buy trades
userSellTradeCountMin (number)      - Min sell trades
userSellTradeCountMax (number)      - Max sell trades
```

## Response Format

```json
{
  "code": "0",
  "success": true,
  "message": "success",
  "data": {}
}
```

## Test Case 1: Update with Min Trades Only

**Request Body**:
```json
{
  "advNo": "13900814235866066944",
  "userTradeCountMin": 20,
  "userTradeCountFilterTime": 30
}
```

**Expected Response**:
```json
{
  "code": "0",
  "success": true,
  "message": "success"
}
```

**Curl Command**:
```bash
curl -X POST https://api.binance.com/sapi/v1/c2c/ads/update \
  -H "X-MBX-APIKEY: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "advNo": "13900814235866066944",
    "userTradeCountMin": 20,
    "userTradeCountFilterTime": 30,
    "timestamp": 1783612000000,
    "signature": "YOUR_SIGNATURE"
  }'
```

## Test Case 2: Update with Multiple Criteria

**Request Body**:
```json
{
  "advNo": "13900814235866066944",
  "userTradeCountMin": 20,
  "userTradeCountFilterTime": 30,
  "userTradeCompleteRateMin": 98,
  "userTradeCompleteRateFilterTime": 30,
  "buyerRegDaysLimit": 100,
  "userAllTradeCountMin": 100,
  "userBuyTradeCountMin": 75,
  "userSellTradeCountMin": 25
}
```

**Expected Response**: Same as Test Case 1

## Test Case 3: Update with Min/Max Range

**Request Body**:
```json
{
  "advNo": "13900814235866066944",
  "userBuyTradeCountMin": 50,
  "userBuyTradeCountMax": 1000,
  "userSellTradeCountMin": 25,
  "userSellTradeCountMax": 1000
}
```

## Common Error Responses

### 400 - Invalid API Key/Permissions
```json
{
  "code": -2015,
  "msg": "Invalid API-key, IP, or permissions for action."
}
```
**Fix**: Check API key has P2P Trading permissions enabled

### 400 - Invalid Parameter
```json
{
  "code": -1000,
  "msg": "Invalid request properties, missing fields [userTradeCountMin], or wrong type."
}
```
**Fix**: Check parameter names and types match exactly

### 404 - Ad Not Found
```json
{
  "code": -1,
  "msg": "Ad not found"
}
```
**Fix**: Verify advNo is correct

## Implementation Checklist

- [ ] advNo is string format
- [ ] userTradeCountMin is integer (not string)
- [ ] userTradeCompleteRateMin is number 0-100
- [ ] userTradeCountFilterTime is 30 (for 30-day)
- [ ] Only enabled criteria are included in payload
- [ ] Binance API key has P2P Trading permission
- [ ] Request is signed with correct HMAC SHA256
- [ ] Content-Type is application/json
- [ ] clientType header = "PC" or "APP"

## Payload Building Logic

```javascript
const payload = {
  advNo: "13900814235866066944"  // MUST include
};

// Only add if ENABLED in database
if (rules.min_30day_trades_enabled) {
  payload.userTradeCountMin = parseInt(rules.min_30day_trades);
  payload.userTradeCountFilterTime = 30;
}

if (rules.min_30day_completion_rate_enabled) {
  payload.userTradeCompleteRateMin = parseFloat(rules.min_30day_completion_rate);
  payload.userTradeCompleteRateFilterTime = 30;
}

if (rules.min_registered_days_enabled) {
  payload.buyerRegDaysLimit = parseInt(rules.min_registered_days);
}

if (rules.min_all_trades_count_enabled) {
  payload.userAllTradeCountMin = parseInt(rules.min_all_trades_count);
}

if (rules.min_buy_orders_count_enabled) {
  payload.userBuyTradeCountMin = parseInt(rules.min_buy_orders_count);
}

if (rules.min_sell_orders_count_enabled) {
  payload.userSellTradeCountMin = parseInt(rules.min_sell_orders_count);
}
```

## Response Validation

```javascript
if (!result || (result.code && result.code !== '0')) {
  // API returned error
  throw new Error(result?.msg || result?.message || 'Binance API error');
}

if (result.success === false) {
  // API returned error
  throw new Error('Binance API returned false');
}

// Success - can proceed to save to database
```

## Testing with Postman

1. Set request type to POST
2. URL: `https://api.binance.com/sapi/v1/c2c/ads/update`
3. Headers:
   - `X-MBX-APIKEY`: Your API key
   - `Content-Type`: application/json
   - `clientType`: PC
4. Body (raw JSON):
   ```json
   {
     "advNo": "13900814235866066944",
     "userTradeCountMin": 20,
     "userTradeCountFilterTime": 30,
     "timestamp": {{timestamp}},
     "signature": "{{signature}}"
   }
   ```
5. Pre-request script to generate signature (see Binance docs)

## Flow

```
Admin saves eligibility
        ↓
Extract only ENABLED criteria
        ↓
Build minimal payload with only needed fields
        ↓
Call Binance updateAd API
        ↓
Validate response:
  - code === '0' ?
  - success === true ?
  ↓
Success → Save to database
Failed → Return error to admin
```

## Key Points

1. **Only enabled criteria** go to Binance
2. **advNo is required**, everything else is optional
3. **Type matters**: use parseInt/parseFloat, not strings
4. **Validate response** for both success and errors
5. **Minimal payload** - only send what changed
6. **API Key permissions** must include P2P Trading

---

Ready to implement and test!
