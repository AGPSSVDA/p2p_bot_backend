# Eligibility Check System - Complete Implementation

## Overview
Comprehensive eligibility checking system for P2P trading platform that validates buyer metrics against per-ad eligibility criteria.

## Database Schema

### 1. `seller_ads` Table
Main ad configuration table with all Binance ad properties and eligibility rules.

```sql
- ad_no (VARCHAR, PRIMARY KEY)
- seller_id (VARCHAR)
- asset, fiat_unit, classify
- price, priceType, priceFloatingRatio, commissionRate
- minOrder, maxOrder, surplusAmount, initAmount
- tradeType, isActive, advStatus
- remarks, autoReplyMsg, payTimeLimit
- createdAt, updatedAt
```

### 2. `seller_ad_rules` Table
Per-ad eligibility criteria and verification methods configuration.

```sql
- ad_no (VARCHAR, PRIMARY KEY, FOREIGN KEY → seller_ads)

-- Eligibility Criteria (11 rules)
- min_30day_trades (INT, default 0)
- min_30day_completion_rate (DECIMAL, default 0)
- max_avg_release_time (INT, default 0) -- in minutes
- max_avg_pay_time (INT, default 0) -- in minutes
- min_registered_days (INT, default 0)
- min_first_trade_days (INT, default 0)
- min_trading_counterparty (INT, default 0)
- min_all_trades_count (INT, default 0)
- min_buy_orders_count (INT, default 0)
- min_sell_orders_count (INT, default 0)
- required_trade_type (VARCHAR, default 'ANY')

-- Verification Methods (3 methods with sub-options)
- method1_liveness_enabled (BOOLEAN)
- method2_documents_enabled (BOOLEAN)
- method2_mobile_verification_enabled (BOOLEAN)
- method3_full_enabled (BOOLEAN)
- method3_mobile_verification_enabled (BOOLEAN)
- method3_payment_link_enabled (BOOLEAN)
- method3_payment_gateway (VARCHAR)
- method3_delivery_method (VARCHAR)

- createdAt, updatedAt
```

### 3. `seller_buyer_metrics` Table
Stores buyer metrics for eligibility checking.

```sql
- buyer_id (VARCHAR, PRIMARY KEY)
- trades_30day (INT)
- completion_rate_30day (DECIMAL)
- registered_days (INT)
- trading_counterparty_count (INT)
- all_trades_count (INT)
- buy_orders_count (INT)
- sell_orders_count (INT)
- avg_release_time_minutes (INT)
- avg_pay_time_minutes (INT)
- createdAt, updatedAt
```

### 4. `seller_orders` Table
Order information with eligibility check results.

```sql
- order_number (VARCHAR, PRIMARY KEY)
- ad_no (VARCHAR, FOREIGN KEY → seller_ads)
- buyer_id (VARCHAR, FOREIGN KEY → seller_buyer_metrics)
- buyer_nickname (VARCHAR)
- buyer_kyc_name (VARCHAR)
- eligibility_check_passed (BOOLEAN)
- eligibility_check_completed_at (DATETIME)
- eligibility_check_failed_reason (TEXT)
- [... other order tracking fields ...]
```

### 5. `seller_ad_trade_methods` Table
Payment methods linked to ads with commission rates.

```sql
- id (INT, PRIMARY KEY, AUTO_INCREMENT)
- ad_no (VARCHAR, FOREIGN KEY → seller_ads)
- pay_id (INT)
- pay_type (VARCHAR)
- identifier (VARCHAR)
- trade_method_name (VARCHAR)
- icon_url (VARCHAR)
- commission_rate (DECIMAL)
```

## Backend Implementation

### Services

#### `sellerOrderDbService.js`
Database operations for orders and eligibility rules.

**Key Methods:**
- `getAdRules(adNo)` - Fetch eligibility rules for an ad
- `getAdByNo(adNo)` - Fetch ad details
- `getBuyerMetrics(buyerId)` - Fetch buyer metrics
- `getOrderByNumber(orderNo)` - Fetch order by number
- `upsertAdTradeMethod(adNo, method)` - Save payment methods

#### `sellerEligibilityService.js`
Core eligibility checking logic.

**Key Method:**
```javascript
async checkBuyerEligibility(buyerId, adNo) {
  // Validates 11 criteria:
  // 1. Min 30-day trades
  // 2. Min 30-day completion rate (%)
  // 3. Max avg release time (minutes)
  // 4. Max avg pay time (minutes)
  // 5. Min registered days
  // 6. Min first trade days
  // 7. Min trading counterparties
  // 8. Min all trades count
  // 9. Min buy orders count
  // 10. Min sell orders count
  // 11. Required trade type
  
  Returns: {
    eligible: boolean,
    failedChecks: [
      { criterion, required, actual }
    ]
  }
}
```

**Comparison Logic:**
- For "Min" criteria: `actual >= required`
- For "Max" criteria: `actual <= required`
- For "None/ANY" criteria: Always passes

### Controllers

#### `sellerOrdersController.js`

**GET `/api/seller/orders/:orderNo/eligibility-check`**

Response:
```json
{
  "success": true,
  "data": {
    "orderNo": "order123",
    "buyer": {
      "id": "buyer_id",
      "nickname": "BuyerName",
      "kycName": "KYC Name"
    },
    "ad": {
      "adNo": "ad_no",
      "asset": "USDT",
      "fiatUnit": "INR",
      "classify": "profession"
    },
    "eligibility": {
      "checkCompleted": false,
      "passed": false,
      "failedReason": null,
      "checkedAt": null
    },
    "criteria": [
      {
        "criterion": "30-Day Trades",
        "required": 20,
        "actual": 5,
        "passed": false
      },
      // ... 10 more criteria
    ],
    "buyerMetrics": {
      "trades30Day": 50,
      "completionRate": "99.50",
      "avgReleaseTime": 2,
      "avgPayTime": 10,
      "registeredDays": 250,
      "tradingCounterparties": 80,
      "allTradesCount": 300,
      "buyOrdersCount": 150,
      "sellOrdersCount": 150
    }
  }
}
```

### Polling System

#### `sellerOrderPoller.js`

Continuously monitors orders and runs eligibility checks:

1. Fetches all active ads for seller
2. For each ad:
   - Gets ad-specific eligibility rules
   - Polls Binance for orders on that ad
   - For each new order:
     - Fetches buyer metrics
     - Runs eligibility check
     - Starts order handler

## Frontend Implementation

### Components

#### `EligibilityCheckModal.tsx`

Modal dialog showing detailed eligibility check results.

**Features:**
- Buyer information (ID, nickname, KYC name)
- Ad details (adNo, asset, fiatUnit, classify)
- Eligibility status (passed/failed with reason)
- All 11 criteria with pass/fail indicators
- Required vs actual comparison
- Buyer metrics table
- Color-coded sections (blue for buyer, indigo for ad, green for passed, red for failed)

**Props:**
```typescript
interface EligibilityCheckModalProps {
  orderNo: string;
  isOpen: boolean;
  onClose: () => void;
}
```

### Service

#### `seller.service.ts`

```typescript
async getEligibilityCheckDetails(orderNo: string) {
  const res = await api.get(`/seller/orders/${orderNo}/eligibility-check`);
  return res.data.data;
}
```

## Test Cases

### Test 1: PASSED Eligibility
**Buyer: TestBuyer (testbuyer12345)**

Metrics:
- 30-Day Trades: 50 ✅ (required: 20)
- Completion Rate: 99.5% ✅ (required: 98%)
- Avg Release Time: 2 min ✅ (max: 3 min)
- Avg Pay Time: 10 min ✅ (max: 15 min)
- Registered Days: 250 ✅ (required: 100)
- Trading Counterparties: 80 ✅ (required: 50)
- All Trades Count: 300 ✅ (required: 100)
- Buy Orders: 150 ✅ (required: 75)
- Sell Orders: 150 ✅ (required: 25)

**Result: ✅ PASSED (10/10 criteria)**

### Test 2: FAILED Eligibility
**Buyer: FailedBuyer (failedbuyer12345)**

Metrics:
- 30-Day Trades: 5 ❌ (required: 20)
- Completion Rate: 85% ❌ (required: 98%)
- Avg Release Time: 20 min ❌ (max: 3 min)
- Avg Pay Time: 30 min ❌ (max: 15 min)
- Registered Days: 30 ❌ (required: 100)
- Trading Counterparties: 10 ❌ (required: 50)
- All Trades Count: 20 ❌ (required: 100)
- Buy Orders: 5 ❌ (required: 75)
- Sell Orders: 5 ❌ (required: 25)

**Result: ❌ FAILED (0/10 criteria)**

## Sample Ad Configuration

**AD: 13900814235866066944**

```
Asset: USDT/INR
Classify: profession
Status: Online

Eligibility Rules:
├── Min 30-Day Trades: 20
├── Min Completion Rate: 98%
├── Max Avg Release Time: 3 min
├── Max Avg Pay Time: 15 min
├── Min Registered Days: 100
├── Min Trading Counterparties: 50
├── Min All Trades Count: 100
├── Min Buy Orders: 75
├── Min Sell Orders: 25
├── Required Trade Type: multy product
└── Min First Trade Days: 100
```

## API Endpoints

### Eligibility Check
- **GET** `/api/seller/orders/:orderNo/eligibility-check`
- **Auth:** Required (seller_id from JWT)
- **Response:** Detailed eligibility check with all criteria and metrics

### Trade Types (Custom)
- **GET** `/api/seller/trade-types` - List all trade types
- **POST** `/api/seller/trade-types` - Create custom trade type
- **DELETE** `/api/seller/trade-types/:tradeTypeName` - Delete trade type

### Ad Rules
- **PUT** `/api/seller/ads/:adNo/rules` - Update eligibility rules and methods

## Key Features

✅ 11 configurable eligibility criteria per ad
✅ 3 verification methods (Liveness, Documents, Full Verification)
✅ Per-method configuration options
✅ Custom trade type support
✅ Real-time buyer metrics tracking
✅ Detailed eligibility reports
✅ Min vs Max criteria logic
✅ Order polling integration
✅ Beautiful UI with color-coded sections
✅ Complete API documentation

## Next Steps

1. **Polling Integration**: Orders fetched from Binance automatically trigger eligibility checks
2. **Notification System**: Send eligibility results to buyers via chat/API
3. **Trade Type Filtering**: Filter orders by required trade type
4. **Advanced Reporting**: Analytics on eligibility pass rates
5. **Rule Templates**: Pre-built rule templates for different ad types
