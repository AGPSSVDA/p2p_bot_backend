# Complete Order Eligibility Flow - Implementation Guide

## Overview
जब कोई buyer Binance पर order place करे:
1. Order fetch करो (polling)
2. Buyer की info और metrics निकालो
3. AD की eligibility criteria से match करो
4. Eligible है तो liveness check शुरू करो
5. Liveness complete है तो thank you message भेजो
6. Ineligible है तो failure reason भेजो

---

## Flow Diagram

```
┌────────────────────────────────────────────────────────┐
│ 1. BUYER PLACES ORDER ON BINANCE                       │
└────────────────────────────────────────────────────────┘
                         ↓
┌────────────────────────────────────────────────────────┐
│ 2. POLLING DETECTS ORDER                               │
│    Endpoint: POST /sapi/v1/c2c/orderMatch/listOrders   │
│    Returns: orderNumber, counterPartUserId,            │
│             counterPartNickName, amount, etc           │
└────────────────────────────────────────────────────────┘
                         ↓
┌────────────────────────────────────────────────────────┐
│ 3. FETCH BUYER METRICS FROM BINANCE                    │
│    Endpoint: GET /sapi/v1/c2c/orderMatch/queryCounter │
│              PartyOrderStatistic                       │
│    Returns: trades_30day, completion_rate, etc        │
│    Also fetch: queryCounterPartyOrderStatistic         │
└────────────────────────────────────────────────────────┘
                         ↓
┌────────────────────────────────────────────────────────┐
│ 4. GET AD ELIGIBILITY RULES FROM DATABASE              │
│    Query: SELECT * FROM seller_ad_rules                │
│    WHERE ad_no = order.ad_no                           │
│    Returns: All 11 criteria + 3 methods config         │
└────────────────────────────────────────────────────────┘
                         ↓
┌────────────────────────────────────────────────────────┐
│ 5. MATCH BUYER METRICS WITH AD CRITERIA                │
│    Compare 10 criteria (see below)                     │
└────────────────────────────────────────────────────────┘
                    ↙                    ↘
         ✅ ELIGIBLE                ❌ INELIGIBLE
             ↓                           ↓
    ┌──────────────────────┐   ┌──────────────────────┐
    │ 6A. SEND LIVENESS    │   │ 6B. SEND FAILURE MSG │
    │     REQUEST          │   │     TO BUYER         │
    │ (if method 1 enabled)│   │                      │
    │                      │   │ Endpoint:            │
    │ Endpoint:            │   │ POST /sapi/v1/c2c/   │
    │ POST /sapi/v1/c2c/   │   │ chat/sendMessage     │
    │ orderMatch/verified  │   │                      │
    │ AdditionalKyc        │   │ Message: "You don't  │
    │                      │   │ meet criteria: X, Y" │
    │ + Chat message:      │   └──────────────────────┘
    │ POST /sapi/v1/c2c/   │
    │ chat/sendMessage     │
    └──────────────────────┘
             ↓
    ┌──────────────────────┐
    │ 7. WAIT FOR LIVENESS │
    │    COMPLETION        │
    │ (polling or webhook) │
    └──────────────────────┘
             ↓
    ┌──────────────────────┐
    │ 8. SEND THANK YOU    │
    │    MESSAGE           │
    │                      │
    │ Endpoint:            │
    │ POST /sapi/v1/c2c/   │
    │ chat/sendMessage     │
    │                      │
    │ Message: "Payment    │
    │ successful! Thank you│
    │ for trading!"        │
    └──────────────────────┘
```

---

## Binance Endpoints (से @sapi-v7.4 (1).md)

### 1. Get Pending Orders
```
POST /sapi/v1/c2c/orderMatch/listOrders
```
**Params:**
- tradeType: "SELL"
- orderStatus: 0 (NEW), 1 (UNPAID)

**Response:**
```json
{
  "orderNumber": "string",
  "adOrderNo": "string",           // AD की ID
  "counterPartUserId": "string",   // Buyer ID
  "counterPartNickName": "string", // Buyer नाम
  "amount": 0,                      // Crypto amount
  "totalPrice": 0,                  // Fiat amount
  "tradeCoinCode": "string",        // Asset (USDT, etc)
  "fiat": "string",                 // Fiat currency (INR, etc)
  "orderStatus": 0,
  "createTime": 0
}
```

### 2. Get Buyer's Counter Party Stats
```
POST /sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic
```
**Body:**
```json
{
  "orderNumber": "string"
}
```

**Response:**
```json
{
  "purchaseOrderCount": 0,      // Buy orders count
  "purchaseOrderCompleteCount": 0,
  "purchaseOrderCompleteRate": "string",
  "saleOrderCount": 0,          // Sell orders count
  "saleOrderCompleteCount": 0,
  "saleOrderCompleteRate": "string",
  "totalCompleteOrderCount": 0, // All trades count
  "totalCompleteRate": "string",  // Completion rate %
  "tradeDay": 0                  // Registered days
}
```

### 3. Get User Details
```
GET /sapi/v1/c2c/user/queryUser
```
**Params:**
- userId: string

**Response:**
```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "mobile": "string",
  "tradeCountFilterTimeWindow": 0
}
```

### 4. Send Message to Buyer
```
POST /sapi/v1/c2c/chat/sendMessage
```
**Body:**
```json
{
  "orderNo": "string",
  "content": "string",
  "msgType": "TEXT"  // or "IMAGE"
}
```

**Response:**
```json
{
  "code": 0,
  "message": "Success"
}
```

### 5. Verify Order (After Liveness)
```
POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc
```
**Body:**
```json
{
  "orderNumber": "string"
}
```

---

## Database Tables

### seller_orders
```sql
order_number          VARCHAR PRIMARY KEY
buyer_id              VARCHAR
buyer_nickname        VARCHAR
buyer_kyc_name        VARCHAR
ad_no                 VARCHAR (FK → seller_ads)
fiat_amount           DECIMAL
fiat_unit             VARCHAR
crypto_amount         DECIMAL
current_state         VARCHAR
eligibility_check_passed     BOOLEAN (NULL, 0, 1)
eligibility_check_completed_at  DATETIME
eligibility_check_failed_reason  TEXT
liveness_completed_at   DATETIME
liveness_requested_at   DATETIME
created_at            DATETIME
```

### seller_buyer_metrics
```sql
buyer_id              VARCHAR PRIMARY KEY
trades_30day          INT
completion_rate_30day DECIMAL
registered_days       INT
trading_counterparty_count INT
all_trades_count      INT
buy_orders_count      INT
sell_orders_count     INT
avg_release_time_minutes  INT
avg_pay_time_minutes  INT
created_at            DATETIME
updated_at            DATETIME
```

### seller_ad_rules
```sql
ad_no                 VARCHAR PRIMARY KEY (FK → seller_ads)
min_30day_trades      INT
min_30day_completion_rate DECIMAL
max_avg_release_time  INT
max_avg_pay_time      INT
min_registered_days   INT
min_trading_counterparty INT
min_all_trades_count  INT
min_buy_orders_count  INT
min_sell_orders_count INT

-- Methods
method1_liveness_enabled BOOLEAN
method2_documents_enabled BOOLEAN
method2_mobile_verification_enabled BOOLEAN
method3_full_enabled BOOLEAN
method3_mobile_verification_enabled BOOLEAN
method3_payment_link_enabled BOOLEAN
method3_payment_gateway VARCHAR
method3_delivery_method VARCHAR
```

---

## Code Files to Update

### 1. src/seller/bot/sellerOrderPoller.js
- Update `fetchOrdersFromBinance()` to use correct endpoint
- Replace `createMockBuyerMetrics()` with real Binance API call

### 2. src/services/binanceService.js
- Add `getCounterPartyStats(orderNo)` 
- Add `getUserDetails(userId)`
- Update endpoint URLs from config

### 3. src/seller/bot/sellerOrderHandler.js
- ALREADY IMPLEMENTED ✅
- Just ensure it calls the updated services

### 4. src/services/chatService.js
- ALREADY IMPLEMENTED ✅
- Just ensure `sendMessage()` works correctly

---

## 10 Eligibility Criteria

| # | Criterion | Check | Min/Max | Example |
|---|-----------|-------|---------|---------|
| 1 | 30-Day Trades | trades_30day >= min | MIN | Required: 20, Actual: 50 ✅ |
| 2 | Completion Rate | completion_rate >= min | MIN | Required: 98%, Actual: 99.5% ✅ |
| 3 | Release Time | avg_release_time <= max | MAX | Max: 3 min, Actual: 2 min ✅ |
| 4 | Pay Time | avg_pay_time <= max | MAX | Max: 15 min, Actual: 10 min ✅ |
| 5 | Registered Days | registered_days >= min | MIN | Required: 100, Actual: 250 ✅ |
| 6 | First Trade Days | registered_days >= min | MIN | Required: 100, Actual: 250 ✅ |
| 7 | Trading Counterparties | counterparties >= min | MIN | Required: 50, Actual: 80 ✅ |
| 8 | All Trades Count | all_trades >= min | MIN | Required: 100, Actual: 300 ✅ |
| 9 | Buy Orders | buy_orders >= min | MIN | Required: 75, Actual: 150 ✅ |
| 10 | Sell Orders | sell_orders >= min | MIN | Required: 25, Actual: 150 ✅ |

---

## Example Messages

### Eligibility Passed
```
✅ Congratulations! You meet all the seller's criteria.

We'll now send you a liveness verification request. 
Please complete it to proceed with your order.
```

### Eligibility Failed
```
❌ Unfortunately, you don't meet the seller's criteria for this transaction:

• 30 day trades count: Required 20, Your: 5
• Completion rate: Required 98.00%, Your: 85.00%
• Registered days: Required 100, Your: 30

Please improve your trading history and try again.
```

### Liveness Request
```
📱 Please complete the liveness check on Binance to verify your identity.

This is required for your security and to proceed with the transaction.
```

### Payment Completed
```
✅ Thank you! Your payment has been received.

Your crypto will be released shortly. 
If you have any issues, please contact the seller through this chat.
```

---

## Implementation Steps

1. **Update binanceService.js**
   - Add methods to fetch buyer metrics
   - Use correct endpoints from @sapi-v7.4 (1).md

2. **Update sellerOrderPoller.js**
   - Remove mock data
   - Call real Binance APIs

3. **Test Flow**
   ```bash
   node CHECK_MY_ORDERS.js
   ```

4. **Monitor Logs**
   ```bash
   tail -f logs/app.log | grep "eligibility\|liveness\|thank you"
   ```

5. **Deploy to Production**
   - npm start
   - Real orders will be processed automatically

---

## Error Handling

### If Binance API fails
- Retry with exponential backoff (3 times)
- If still fails, log error and skip that order
- Notify admin via email

### If buyer metrics missing
- Cannot determine eligibility
- Require manual review
- Send message: "Please verify your Binance account"

### If message send fails
- Retry up to 3 times
- If fails, log and move to next order
- Admin will review later

---

## Testing

```bash
# Terminal 1: Run server
npm start

# Terminal 2: Check orders (in loop)
while true; do
  node CHECK_MY_ORDERS.js
  sleep 30
done

# Terminal 3: Monitor logs
tail -f logs/app.log | grep eligibility
```

---

## Production Checklist

- [ ] Binance API keys configured
- [ ] Database migrations run
- [ ] All endpoints tested
- [ ] Message formatting correct
- [ ] Error handling in place
- [ ] Logging configured
- [ ] Email notifications setup (optional)
- [ ] Rate limiting configured
- [ ] Monitoring alerts setup
- [ ] Runbook documented

---

## Next: Implementation

Starting with updating binanceService.js and sellerOrderPoller.js...
