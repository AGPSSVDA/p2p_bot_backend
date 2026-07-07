# ✅ Binance C2C SAPI v7.4 - Correct Implementation

## 🎯 The Problem

We were using **WRONG endpoints** that **don't exist in v7.4**:
- ❌ `/sapi/v1/c2c/user/ads/list` — **REMOVED in v7.4**
- ❌ `/sapi/v1/c2c/ads/searchAdsByPage` — **REMOVED in v7.4**

**From official docs - these APIs were REMOVED:**
```
. Get Ads List with pagination ← We were trying this (WRONG NAME)
. Search Ads with Condition ← We were trying this (WRONG)
```

---

## ✅ Correct Endpoint (v7.4)

```
POST /sapi/v1/c2c/ads/listWithPagination
```

### Required Headers
```javascript
{
  "X-MBX-APIKEY": "your_api_key",
  "Content-Type": "application/json",
  "clientType": "PC"  // ← CRITICAL! We were missing this
}
```

### Body (JSON)
```javascript
{
  "page": 1,
  "rows": 50,
  "tradeType": "SELL",  // Get seller ads
  // Optional filters:
  "asset": "USDT",
  "fiatUnit": "INR",
  "advStatus": 1  // 1=Online, 3=Offline, 4=Closed
}
```

### Query String
```
?timestamp={timestamp}&signature={signature}
```

---

## 📊 Response Format

```javascript
{
  "code": "000000",
  "message": "success",
  "data": {
    "code": "000000",
    "message": "success",
    "total": 5,
    "pageIndex": 1,
    "pageSize": 50,
    "data": [  // ← Array of ads (res.data.data.data[])
      {
        "advNo": "10191633467710386176",
        "tradeType": "SELL",
        "asset": "USDT",
        "fiatUnit": "INR",
        "price": 83.5,
        "minSingleTransAmount": 1000,
        "maxSingleTransAmount": 500000,
        "advStatus": 1,  // 1=Online
        "surplusAmount": 10000
      }
    ]
  }
}
```

---

## 🔧 Code Fix

### Step 1: Update sellerBinanceService.js

Replace `getSellerAds()` function:

```javascript
async function getSellerAds(page = 1, rows = 50) {
  console.log(`\n📡 [SELLER BINANCE] Fetching ads (page=${page}, rows=${rows})`);
  console.log(`📍 [SELLER BINANCE] API Key: ${sellerBinanceConfig.apiKey?.substring(0, 15)}...`);

  try {
    // Build body with search parameters
    const body = {
      page,
      rows,
      tradeType: 'SELL'  // Get seller ads only
    };

    // Build signature (only timestamp in query string)
    const qs = buildSignedQuery({});
    const endpoint = '/sapi/v1/c2c/ads/listWithPagination';
    const requestUrl = `${sellerBinanceConfig.baseUrl}${endpoint}?${qs}`;

    console.log(`🔄 [SELLER BINANCE] Endpoint: ${endpoint}`);
    console.log(`🌐 [SELLER BINANCE] Request URL: ${requestUrl.substring(0, 100)}...`);

    // CRITICAL: Add clientType header!
    const res = await axios.post(
      requestUrl,
      body,  // ← Body with search parameters (NOT empty!)
      {
        headers: {
          'X-MBX-APIKEY': sellerBinanceConfig.apiKey,
          'Content-Type': 'application/json',
          'clientType': 'PC'  // ← REQUIRED HEADER!
        },
        timeout: 8000
      }
    );

    console.log(`✅ [SELLER BINANCE] Status: ${res.status}`);

    // Parse response - note the structure: res.data.data.data
    const adsList = res.data?.data?.data || [];
    console.log(`📦 [SELLER BINANCE] Found ${adsList.length} ads`);

    if (adsList.length > 0) {
      console.log(`📋 [SELLER BINANCE] First ad:`, {
        advNo: adsList[0].advNo,
        asset: adsList[0].asset,
        price: adsList[0].price
      });
    }

    logger.info('✅ [SELLER BINANCE] Fetched seller ads', {
      count: adsList.length,
      endpoint,
      page
    });

    // Map to expected format
    return adsList.map(a => ({
      advNo: a.advNo,
      tradeType: a.tradeType,
      asset: a.asset,
      fiat: a.fiatUnit,
      price: a.price,
      minSingleTransAmount: a.minSingleTransAmount,
      maxSingleTransAmount: a.maxSingleTransAmount,
      advStatus: a.advStatus,
      surplusAmount: a.surplusAmount,
      raw: a
    }));

  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;

    console.error(`❌ [SELLER BINANCE] Error (${status}): ${errorMsg}`);
    console.error(`📍 [SELLER BINANCE] Error details:`, error.response?.data);

    logger.error(`❌ [SELLER BINANCE] Failed to fetch ads`, {
      status,
      error: errorMsg
    });

    throw error;
  }
}
```

### Step 2: Update test-seller-api.js

Replace test function to use correct format:

```javascript
async function testEndpoint(endpoint) {
  try {
    const qs = buildSignedQuery({});
    const url = `https://api.binance.com${endpoint.path}?${qs}`;

    console.log(`\n🧪 Testing: ${endpoint.name}`);
    console.log(`   Path: ${endpoint.path}`);

    const response = await axios({
      method: 'POST',
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
        'clientType': 'PC'  // ← ADD THIS!
      },
      data: {  // ← Body parameters
        page: 1,
        rows: 10,
        tradeType: 'SELL'
      },
      timeout: 5000,
      validateStatus: () => true
    });

    const status = response.status;

    if (status === 200) {
      const adsList = response.data?.data?.data || [];
      console.log(`   ✅ SUCCESS (200) - Found ${adsList.length} ads`);
      if (adsList.length > 0) {
        console.log(`   📋 Sample: ${adsList[0].advNo} (${adsList[0].asset})`);
      }
      return { success: true, endpoint, status };
    } else if (status === 401 || status === 403) {
      console.log(`   ⚠️  Permission Error (${status})`);
      return { success: false, endpoint, status, reason: 'Permission' };
    } else if (status === 404) {
      console.log(`   ❌ Endpoint Not Found (404)`);
      return { success: false, endpoint, status, reason: '404' };
    } else {
      console.log(`   ❌ Error (${status})`);
      return { success: false, endpoint, status };
    }
  } catch (error) {
    console.log(`   ❌ Network Error: ${error.message}`);
    return { success: false, endpoint, error: error.message };
  }
}
```

### Step 3: Update .env

```env
BINANCE_SELLER_ADS_ENDPOINT=/sapi/v1/c2c/ads/listWithPagination
```

---

## 🚀 Test It

```bash
node test-seller-api.js
```

Should now show:
```
🧪 Testing: V1 - listWithPagination
   Path: /sapi/v1/c2c/ads/listWithPagination
   ✅ SUCCESS (200) - Found X ads
```

---

## 📝 Summary

| Item | Before (❌) | After (✅) |
|------|-----------|----------|
| Endpoint | `/sapi/v1/c2c/user/ads/list` | `/sapi/v1/c2c/ads/listWithPagination` |
| `clientType` Header | Missing | Added |
| Body | `{}` | `{ page, rows, tradeType }` |
| Response Path | `res.data` | `res.data.data.data` |

---

## ✅ Why This Works

From **official Binance docs (sapi-v7.4.md)**:

**"4. Get Ads List with pagination"**
- Endpoint: `POST /sapi/v1/c2c/ads/listWithPagination`
- Required: `clientType` header (string)
- Body: `{ page, rows, tradeType, ... }`
- Response: `CommonPageRet_AdDetailResp_`

All the endpoints we tried were **REMOVED in v7.4** according to the release notes at the top of the doc! 🎉
