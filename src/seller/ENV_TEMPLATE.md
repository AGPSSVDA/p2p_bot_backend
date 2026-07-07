# SELLER SYSTEM - ENVIRONMENT CONFIGURATION

Add these environment variables to your `.env` file to enable and configure the seller system.

---

## BASIC CONFIGURATION

```env
# Enable seller mode (start seller order poller)
SELLER_MODE=true

# Seller ID (which seller this bot instance processes orders for)
SELLER_ID=seller_123

# Seller name (for logging)
SELLER_NAME=My Store
```

---

## POLLING CONFIGURATION

```env
# Order polling interval (milliseconds)
SELLER_ORDER_POLL_INTERVAL=5000

# Number of orders to fetch per poll
SELLER_ORDERS_LIMIT=20

# Enable verbose logging for seller operations
SELLER_DEBUG=false
```

---

## VERIFICATION CONFIGURATION

### Timeouts

```env
# Liveness verification timeout (milliseconds, default: 10 minutes)
SELLER_LIVENESS_TIMEOUT=600000

# Document upload timeout (milliseconds, default: 15 minutes)
SELLER_DOCUMENT_TIMEOUT=900000

# Mobile OTP timeout (milliseconds, default: 5 minutes)
SELLER_OTP_TIMEOUT=300000

# Payment confirmation timeout (milliseconds, default: 24 hours)
SELLER_PAYMENT_TIMEOUT=86400000
```

### Retry Configuration

```env
# Max retries for verification attempts
SELLER_MAX_RETRIES=3

# Retry delay (milliseconds)
SELLER_RETRY_DELAY=5000
```

---

## PAYMENT GATEWAY CONFIGURATION

### Razorpay (for Method 3 - Payment Link)

```env
# Razorpay API Key (public)
RAZORPAY_KEY_ID=your_razorpay_key

# Razorpay API Secret (private)
RAZORPAY_KEY_SECRET=your_razorpay_secret

# Razorpay Webhook Secret (for verifying signatures)
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Razorpay Account ID (if using multiple accounts)
RAZORPAY_ACCOUNT_ID=acc_123456
```

### Paywize (for Method 3 - Payment Link)

```env
# Paywize Merchant ID
PAYWIZE_MERCHANT_ID=your_merchant_id

# Paywize API Key
PAYWIZE_API_KEY=your_api_key

# Paywize API Secret
PAYWIZE_API_SECRET=your_api_secret

# Paywize Webhook Secret
PAYWIZE_WEBHOOK_SECRET=your_webhook_secret
```

---

## VERIFICATION SERVICE CONFIGURATION

### SurePass (Document Verification)

```env
# SurePass API Key (for Aadhaar + PAN verification)
SUREPASS_API_KEY=your_surepass_key

# SurePass API URL
SUREPASS_API_URL=https://api.surepass.io/api/v1

# Enable document verification (set to false for mock verification)
SUREPASS_ENABLED=true
```

### OTP Service

```env
# OTP provider (surepass, twilio, etc)
OTP_PROVIDER=surepass

# OTP length (digits)
OTP_LENGTH=6

# OTP validity (seconds)
OTP_VALIDITY=300

# Max OTP attempts
OTP_MAX_ATTEMPTS=3
```

---

## DATABASE CONFIGURATION (Seller)

```env
# MySQL database for seller system
SELLER_DB_HOST=localhost
SELLER_DB_PORT=3306
SELLER_DB_USER=root
SELLER_DB_PASSWORD=your_password
SELLER_DB_NAME=seller_system

# Connection pooling
SELLER_DB_POOL_SIZE=10
SELLER_DB_POOL_TIMEOUT=30000
```

---

## LOGGING CONFIGURATION

```env
# Log level for seller operations (debug, info, warn, error)
SELLER_LOG_LEVEL=info

# Log seller bot activity
SELLER_LOG_BOT=true

# Log seller API requests
SELLER_LOG_API=true

# Log seller payments
SELLER_LOG_PAYMENTS=true
```

---

## FEATURE FLAGS

```env
# Enable Method 1 (Liveness) verification
SELLER_METHOD1_ENABLED=true

# Enable Method 2 (Documents + OTP) verification
SELLER_METHOD2_ENABLED=true

# Enable Method 3 (Full verification) verification
SELLER_METHOD3_ENABLED=true

# Enable auto-payment for Method 3
SELLER_AUTO_PAYMENT=false

# Enable seller dashboard API
SELLER_API_ENABLED=true

# Enable payment webhooks
SELLER_WEBHOOKS_ENABLED=true
```

---

## WEBHOOK CONFIGURATION

```env
# Seller Razorpay webhook URL (must be public)
SELLER_RAZORPAY_WEBHOOK_URL=https://your-domain.com/api/seller/razorpay/webhook

# Seller Paywize webhook URL (must be public)
SELLER_PAYWIZE_WEBHOOK_URL=https://your-domain.com/api/seller/paywize/webhook

# Webhook retry attempts
SELLER_WEBHOOK_RETRIES=3

# Webhook retry delay (milliseconds)
SELLER_WEBHOOK_RETRY_DELAY=5000
```

---

## MESSAGING CONFIGURATION

```env
# Default currency for seller orders
SELLER_DEFAULT_CURRENCY=INR

# Default crypto asset for seller
SELLER_DEFAULT_ASSET=USDT

# Enable order messages
SELLER_SEND_MESSAGES=true

# Message template customization (if supported)
SELLER_MESSAGE_TEMPLATE_PATH=./src/seller/templates/

# Max message length (characters)
SELLER_MAX_MESSAGE_LENGTH=4096
```

---

## MONITORING & ALERTS

```env
# Enable seller monitoring
SELLER_MONITORING_ENABLED=true

# Alert on order failures
SELLER_ALERT_ON_FAILURE=true

# Alert email (for critical errors)
SELLER_ALERT_EMAIL=admin@example.com

# Alert webhook (for Slack/Discord)
SELLER_ALERT_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Monitor memory usage (restart if above threshold)
SELLER_MEMORY_THRESHOLD=500
```

---

## DEVELOPMENT CONFIGURATION

```env
# Mock services (for development/testing)
SELLER_MOCK_SUREPASS=false
SELLER_MOCK_RAZORPAY=false
SELLER_MOCK_PAYWIZE=false
SELLER_MOCK_BINANCE=false

# Enable seller test mode
SELLER_TEST_MODE=false

# Test seller ID (for testing)
SELLER_TEST_ID=test_seller_123

# Auto-approve orders in test mode
SELLER_AUTO_APPROVE_TEST=false
```

---

## EXAMPLE .env FILE

```env
# Seller System Configuration
SELLER_MODE=true
SELLER_ID=seller_001
SELLER_NAME=My P2P Store

# Polling
SELLER_ORDER_POLL_INTERVAL=5000
SELLER_DEBUG=false

# Timeouts
SELLER_LIVENESS_TIMEOUT=600000
SELLER_DOCUMENT_TIMEOUT=900000
SELLER_OTP_TIMEOUT=300000
SELLER_PAYMENT_TIMEOUT=86400000

# Razorpay
RAZORPAY_KEY_ID=razorpay_key_123
RAZORPAY_KEY_SECRET=razorpay_secret_456

# Paywize
PAYWIZE_MERCHANT_ID=paywize_merchant_789
PAYWIZE_API_KEY=paywize_key_010

# SurePass
SUREPASS_API_KEY=surepass_key_111
SUREPASS_ENABLED=true

# Database
SELLER_DB_HOST=localhost
SELLER_DB_USER=root
SELLER_DB_PASSWORD=root_password
SELLER_DB_NAME=seller_system

# Logging
SELLER_LOG_LEVEL=info
SELLER_LOG_BOT=true

# Features
SELLER_METHOD1_ENABLED=true
SELLER_METHOD2_ENABLED=true
SELLER_METHOD3_ENABLED=true
SELLER_API_ENABLED=true
SELLER_WEBHOOKS_ENABLED=true

# Webhooks
SELLER_RAZORPAY_WEBHOOK_URL=https://your-domain.com/api/seller/razorpay/webhook
SELLER_PAYWIZE_WEBHOOK_URL=https://your-domain.com/api/seller/paywize/webhook

# Defaults
SELLER_DEFAULT_CURRENCY=INR
SELLER_DEFAULT_ASSET=USDT
```

---

## SETUP INSTRUCTIONS

1. **Copy template to .env:**
   ```bash
   cp ENV_TEMPLATE.md .env
   ```

2. **Fill in required values:**
   - SELLER_ID (which seller to process)
   - Database credentials
   - API keys (Razorpay, Paywize, SurePass)

3. **Verify webhook URLs:**
   - Make sure URLs are publicly accessible
   - Test webhook delivery in gateway dashboards

4. **Enable features as needed:**
   - Start with METHOD1 only for testing
   - Enable METHOD2 when document verification is ready
   - Enable METHOD3 when payment webhooks are working

5. **Monitor logs:**
   ```bash
   npm run logs seller
   ```

---

## VERIFICATION CHECKLIST

Before deploying to production:

- [ ] SELLER_MODE=true
- [ ] SELLER_ID configured
- [ ] Database connection working
- [ ] Razorpay/Paywize credentials valid
- [ ] SurePass API key valid
- [ ] Webhook URLs are public and accessible
- [ ] All timeouts configured appropriately
- [ ] Logging level set to 'info' or lower
- [ ] Test order processed successfully
- [ ] Payment webhook received successfully
- [ ] Order completed successfully

---

**Questions?** Check src/seller/README.md or INTEGRATION_GUIDE.md for more details.
