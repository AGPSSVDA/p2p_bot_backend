# PHASE 4 - SELLER API INTEGRATION GUIDE

**Status:** ✅ Phase 4 API Layer Complete  
**Date:** 2026-07-04

---

## WHAT'S BEEN CREATED

### Controllers (3 files)

1. **sellerAdsController.js** - Ad management
   - `getAds()` - List all seller ads with rules
   - `getAdDetail()` - Get specific ad configuration
   - `updateAdRules()` - Seller updates per-ad rules
   - `toggleAd()` - Enable/disable ad

2. **sellerOrdersController.js** - Order management
   - `getOrders()` - List orders with filtering
   - `getOrderDetail()` - Full order details with audit trail
   - `getOrderStats()` - Orders statistics
   - `getOrderTimeline()` - Detailed order timeline

3. **sellerDashboardController.js** - Dashboard overview
   - `getDashboard()` - Complete dashboard overview
   - `getHealthMetrics()` - Seller account health
   - `getActivityLog()` - Activity history

### Routes (1 file)

**sellerRoutes.js** - All API endpoints
- Requires authentication middleware
- Error handling
- Logging for all requests

---

## HOW TO INTEGRATE INTO YOUR APP

### Step 1: Add Routes to Express App

In your `src/index.js` (or main Express setup file):

```javascript
// Import seller routes
const sellerRoutes = require('./seller/routes/sellerRoutes');

// Add middleware and routes
app.use('/api/seller', sellerRoutes);
```

### Step 2: Ensure Auth Middleware Exists

The routes expect `authMiddleware` to be available. If you don't have it, create one:

```javascript
// src/middleware/auth.js
const authMiddleware = (req, res, next) => {
  // Your authentication logic here
  // Should set req.user.id (seller ID)
  // Can throw 401 if unauthorized
  next();
};

module.exports = { authMiddleware };
```

### Step 3: Update Database Service (DONE ✅)

Added `updateAdStatus()` method to `sellerOrderDbService.js`

### Step 4: Verify Database Tables Exist

Run the migration:

```bash
mysql -u root -p < migrations/seller_tables.sql
```

---

## API ENDPOINTS (COMPLETE)

### Dashboard Endpoints

```
GET  /api/seller/dashboard
     - Returns: Dashboard overview with stats

GET  /api/seller/dashboard/health
     - Returns: Seller account health metrics

GET  /api/seller/dashboard/activity
     - Returns: Activity log
     - Query: ?limit=20
```

### Ad Management Endpoints

```
GET  /api/seller/ads
     - Returns: All ads with their rules

GET  /api/seller/ads/:adNo
     - Returns: Specific ad with full config

PUT  /api/seller/ads/:adNo/rules
     - Body: Updated rules data
     - Returns: Confirmation with updated rules

POST /api/seller/ads/:adNo/toggle
     - Body: { isActive: true/false }
     - Returns: Confirmation
```

### Order Management Endpoints

```
GET  /api/seller/orders
     - Query: ?limit=20&offset=0&state=PENDING&adNo=XYZ123
     - Returns: Orders list with pagination

GET  /api/seller/orders/:orderNo
     - Returns: Full order details with audit trail

GET  /api/seller/orders/stats/summary
     - Returns: Orders statistics

GET  /api/seller/orders/timeline/:orderNo
     - Returns: Order timeline with all steps
```

---

## AUTHENTICATION

All routes require the user to be authenticated.

The `authMiddleware` must:
1. Verify the JWT/session token
2. Set `req.user.id` (seller ID)
3. Call `next()` or throw 401

Example:

```javascript
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new Error('No token');

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.sellerId };
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
};
```

---

## RESPONSE FORMAT

All endpoints return consistent JSON format:

**Success (200):**
```json
{
  "success": true,
  "data": { /* endpoint-specific data */ },
  "count": 5,
  "pagination": { "limit": 20, "offset": 0 }
}
```

**Error (400/500):**
```json
{
  "success": false,
  "error": "Error message",
  "errors": ["Validation error 1", "Validation error 2"]
}
```

---

## PERMISSION & AUTHORIZATION

All endpoints check that the seller owns the resource:

```javascript
// Only seller who owns the ad can access it
if (ad.seller_id !== sellerId) {
  return res.status(403).json({
    success: false,
    error: 'Unauthorized access to this ad'
  });
}
```

This is enforced in all controllers.

---

## ERROR HANDLING

All errors are logged and returned with proper status codes:

- `400` - Validation errors
- `403` - Authorization errors (seller doesn't own resource)
- `404` - Resource not found
- `500` - Server errors

---

## INTEGRATION CHECKLIST

- [ ] Copy controllers to `src/seller/controllers/`
- [ ] Copy routes to `src/seller/routes/`
- [ ] Update `src/index.js` to import and use `sellerRoutes`
- [ ] Verify `authMiddleware` exists and sets `req.user.id`
- [ ] Run database migration: `migrations/seller_tables.sql`
- [ ] Test endpoints with authentication
- [ ] Update Postman/API docs with new endpoints

---

## NEXT STEPS (PHASE 5)

### Integration with Bot

1. **Start the Poller in index.js:**
```javascript
const sellerOrderPoller = require('./seller/bot/sellerOrderPoller');

// In your app startup:
if (process.env.SELLER_MODE === 'true') {
  sellerOrderPoller.start();
  logger.info('Seller order poller started');
}
```

2. **Connect Payment Webhooks:**
- Razorpay webhook handler
- Paywize webhook handler
- Route to `sellerVerificationService.handlePaymentWebhook()`

3. **Update Binance Service:**
- Add seller-specific order polling
- Filter by `ad_no` for per-ad polling
- Return orders with `adOrderNo` field

4. **Testing:**
- Unit tests for controllers
- Integration tests for full flow
- E2E tests with real orders

---

## FILES CREATED (PHASE 4)

```
src/seller/
├── controllers/
│   ├── ✅ sellerAdsController.js (250 LOC)
│   ├── ✅ sellerOrdersController.js (350 LOC)
│   └── ✅ sellerDashboardController.js (300 LOC)
│
└── routes/
    └── ✅ sellerRoutes.js (100 LOC)

src/seller/services/
└── ✅ sellerOrderDbService.js (UPDATED: +1 method)
```

**Total: ~1,000 LOC of new API code**

---

## QUICK START

1. **Add to Express:**
```javascript
const sellerRoutes = require('./seller/routes/sellerRoutes');
app.use('/api/seller', sellerRoutes);
```

2. **Run migration:**
```bash
mysql < migrations/seller_tables.sql
```

3. **Test endpoint:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/seller/dashboard
```

4. **Start poller (optional):**
```javascript
const sellerOrderPoller = require('./seller/bot/sellerOrderPoller');
sellerOrderPoller.start();
```

---

## READY FOR PRODUCTION?

Phase 4 API Layer is ready! ✅

**What's still needed (Phase 5):**
- [ ] Integrate poller into index.js
- [ ] Add payment webhook handlers
- [ ] Update Binance service with ad filtering
- [ ] Create tests
- [ ] Deploy to production

---

**Questions?** Check the implementation files in `src/seller/` for details.
