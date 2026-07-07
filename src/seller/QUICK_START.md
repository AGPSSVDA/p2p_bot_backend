# SELLER SYSTEM - QUICK START GUIDE ⚡

**Get the seller system running in 5 minutes!**

---

## 1. CONFIGURE ENVIRONMENT (2 min)

Edit `.env` file and add:

```env
# Seller Configuration
SELLER_MODE=true
SELLER_ID=seller_001
SELLER_NAME=My Store

# Database
SELLER_DB_HOST=localhost
SELLER_DB_PORT=3306
SELLER_DB_USER=root
SELLER_DB_PASSWORD=your_password
SELLER_DB_NAME=seller_system

# Optional: Payment Gateway (for Method 3)
RAZORPAY_KEY_ID=your_key
RAZORPAY_KEY_SECRET=your_secret
PAYWIZE_MERCHANT_ID=your_merchant_id
PAYWIZE_API_KEY=your_key

# Optional: Document Verification
SUREPASS_API_KEY=your_key
SUREPASS_ENABLED=true
```

**Full template:** See `ENV_TEMPLATE.md`

---

## 2. RUN DATABASE MIGRATION (1 min)

```bash
mysql -u root -p < migrations/seller_tables.sql
```

This creates 8 tables for the seller system.

---

## 3. START APPLICATION (1 min)

```bash
npm start
```

You should see:
```
🚀 Seller Order Poller started
🌐 API server listening on http://localhost:5000
```

---

## 4. TEST ENDPOINTS (1 min)

### With Authentication Header

```bash
# Test dashboard
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:5000/api/seller/dashboard

# Test ads
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:5000/api/seller/ads

# Test orders
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:5000/api/seller/orders
```

Expected response:
```json
{
  "success": true,
  "data": { ... }
}
```

---

## 5. REGISTER WEBHOOKS (Optional, for Method 3)

In Razorpay/Paywize dashboard, add webhook URLs:

```
https://your-domain.com/api/seller/razorpay/webhook
https://your-domain.com/api/seller/paywize/webhook
```

---

## WHAT'S RUNNING NOW

✅ **15 API Endpoints**
- Dashboard overview + health + activity
- Ad management (list, get, update, toggle)
- Order management (list, details, stats, timeline)

✅ **Automatic Order Polling**
- Detects orders on all seller ads
- Applies per-ad eligibility rules
- Runs verification flow automatically

✅ **Payment Webhooks**
- Razorpay payment confirmations
- Paywize payment confirmations
- Auto-completes orders on payment

---

## API ENDPOINTS REFERENCE

### Dashboard
```
GET  /api/seller/dashboard
GET  /api/seller/dashboard/health
GET  /api/seller/dashboard/activity
```

### Ads Management
```
GET  /api/seller/ads
GET  /api/seller/ads/:adNo
PUT  /api/seller/ads/:adNo/rules
POST /api/seller/ads/:adNo/toggle
```

### Order Management
```
GET  /api/seller/orders
GET  /api/seller/orders/:orderNo
GET  /api/seller/orders/stats/summary
GET  /api/seller/orders/timeline/:orderNo
```

### Webhooks (Automatic)
```
POST /api/seller/razorpay/webhook
POST /api/seller/paywize/webhook
```

---

## EXAMPLE: PROCESS AN ORDER

1. **Seller has ad on Binance** (configured with rules)
2. **Buyer places order** on that ad
3. **Bot detects order** (via polling every 5 seconds)
4. **Bot checks eligibility** (11 criteria from ad config)
   - If fail → Order rejected
   - If pass → Proceed to verification
5. **Bot runs verification** (based on ad-specific method)
   - Method 1: Wait for Binance liveness
   - Method 2: Request documents + OTP
   - Method 3: Request documents + payment link
6. **Bot verifies order** in Binance
7. **Bot handles payment**
   - Method 1/2: Wait for Binance auto-payment
   - Method 3: Send payment link, wait for webhook
8. **Order completed** → Thank you message sent

---

## VERIFICATION METHODS

### Method 1: Liveness Only
- ✅ Instant verification
- Buyer completes Binance liveness check
- Auto-completes when liveness done

### Method 2: Documents + OTP
- Request Aadhaar + PAN images
- Verify via SurePass API
- Optional mobile OTP verification
- Auto-payment from Binance

### Method 3: Full Verification
- Request Aadhaar + PAN images
- Verify via SurePass API
- Send payment link (Razorpay/Paywize)
- Buyer completes payment
- Auto-complete on webhook

---

## MONITORING

### Check Logs
```bash
# View seller activity
tail -f logs/seller.log

# Filter for orders
grep "SellerOrderHandler" logs/seller.log

# Filter for webhooks
grep "webhook" logs/seller.log
```

### Monitor Dashboard
```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:5000/api/seller/dashboard/health
```

Response shows:
- Completion rate
- Eligibility pass rate
- Rejection rate
- Health score (0-100)

---

## TROUBLESHOOTING

### Poller Not Starting
```
Check: SELLER_MODE=true in .env
Check: SELLER_ID is set
Check: Database connection working
```

### Orders Not Processing
```
Check: Seller ad rules configured
Check: Buyer meets eligibility criteria
Check: Verification method enabled for ad
Check: Logs for specific error
```

### Webhooks Not Working
```
Check: Webhook URL is public (test with curl)
Check: Webhook secret configured correctly
Check: Raw body is being used (not parsed JSON)
Check: Provider sent correct signature
```

---

## CONFIGURATION

### Full Environment Reference
See `ENV_TEMPLATE.md` for all available options

### Key Settings
| Setting | Default | Description |
|---------|---------|-------------|
| SELLER_MODE | false | Enable seller system |
| SELLER_ID | - | Which seller to process |
| SELLER_ORDER_POLL_INTERVAL | 5000 | Poll frequency (ms) |
| SELLER_LIVENESS_TIMEOUT | 600000 | 10 minutes |
| SELLER_DOCUMENT_TIMEOUT | 900000 | 15 minutes |
| SELLER_OTP_TIMEOUT | 300000 | 5 minutes |
| SELLER_PAYMENT_TIMEOUT | 86400000 | 24 hours |

---

## NEXT STEPS

### Immediate
1. ✅ Configure environment variables
2. ✅ Run database migration
3. ✅ Start application
4. ✅ Test endpoints

### Short Term
5. Create seller account on Binance
6. Create ad with rules configured
7. Test order flow with mock order
8. Configure real payment gateways

### Production
9. Replace mock APIs with real ones
10. Configure production webhooks
11. Set up monitoring/alerts
12. Deploy to production

---

## DOCUMENTATION

| Document | Purpose |
|----------|---------|
| README.md | System overview |
| INTEGRATION_GUIDE.md | Detailed integration steps |
| ENV_TEMPLATE.md | Configuration reference |
| QUICK_START.md | This file - get running fast |
| Code comments | Implementation details |

---

## API RESPONSE EXAMPLE

### Dashboard Response
```json
{
  "success": true,
  "data": {
    "summary": {
      "ads": { "total": 5, "active": 4 },
      "orders": { "total": 150, "completed": 120 },
      "volume": { "fiat": 500000, "crypto": 20 }
    },
    "verification": {
      "liveness": { "completed": 80 },
      "documents": { "verified": 100 },
      "payment": { "received": 120 }
    },
    "health": {
      "conversionRate": 80,
      "eligibilityPassRate": 93,
      "avgOrderValue": 3333
    }
  }
}
```

---

## SUCCESS INDICATORS

After starting the system, verify:

- ✅ App starts without errors
- ✅ Dashboard endpoint returns data (with auth)
- ✅ Ads endpoint lists seller ads
- ✅ Orders endpoint lists orders
- ✅ Poller logs show polling activity
- ✅ Webhooks respond to POST requests

---

## QUICK COMMANDS

```bash
# Start application
npm start

# Run database migration
mysql < migrations/seller_tables.sql

# Test dashboard (replace TOKEN)
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:5000/api/seller/dashboard

# View logs
tail -f logs/seller.log | grep seller

# Test webhook locally
curl -X POST http://localhost:5000/api/seller/razorpay/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"payment.authorized","payment":{"id":"pay_123"}}'
```

---

## THAT'S IT! 🎉

Your seller system is now running!

**Next:** Check README.md for more details or INTEGRATION_GUIDE.md for advanced setup.

---

**Questions?** Check the documentation files or examine code comments in src/seller/
