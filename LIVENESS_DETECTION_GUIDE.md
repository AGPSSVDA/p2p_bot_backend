# Binance Liveness Detection - Complete Guide

## Key Findings from SAPI v7.4 Research

### **1. How Liveness Works (State Machine)**

```
Order Created
    ↓
additionalKycVerify = 1 (pending liveness)
    ↓
Buyer completes liveness on Binance UI
    ↓
[No auto-update in Binance API]
    ↓
WE MUST CALL: verifyAdditionalKyc()
    ↓
additionalKycVerify = 2 (verified) ✅
```

### **2. Critical Facts**

| Fact | Details |
|------|---------|
| **Primary Field** | `additionalKycVerify` (0/1/2) |
| **States** | 0=not required, 1=pending, 2=verified |
| **Auto-update** | ❌ NO - must call endpoint manually |
| **Endpoint** | `POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc` |
| **Input** | Just `orderNumber` |
| **Output** | `kycVerified` (boolean), response status |
| **Timing** | Immediate (synchronous) |
| **Delay after call** | None - status changes instantly |
| **Authentication** | Not required |
| **Polling needed** | Yes, to detect state changes |
| **WebHook/Push** | ❌ Not available |
| **Chat detection** | Not reliable (user-dependent) |

### **3. State Transition Details**

```javascript
BEFORE calling verifyAdditionalKyc():
  - additionalKycVerify: 1
  - kycVerified: undefined (field not present)
  - chatUnreadCount: might be 0 or >0

AFTER calling verifyAdditionalKyc():
  - Response: { success: true, kycVerified: true, ... }
  - additionalKycVerify: 2
  - Order ready for next step

ERROR case:
  - Response: { success: false, message: "error details" }
  - additionalKycVerify: remains 1
  - Means: Liveness likely not completed on Binance UI
```

### **4. Correct Detection Flow**

```
1. Order arrives with additionalKycVerify = 1
   ↓
2. Start polling loop (every 5-10 seconds)
   ↓
3. Check current additionalKycVerify value
   ↓
4. Compare with previous value
   ↓
5. If changed from 1 → 2:
      Call verifyAdditionalKyc()
   Else if still 1:
      Continue polling (Binance hasn't updated)
   ↓
6. After verifyAdditionalKyc() call:
      Wait 1-2 seconds
      Re-fetch order status
      Confirm additionalKycVerify = 2
   ↓
7. Proceed with order verification
```

### **5. Why chatUnreadCount is NOT Reliable**

- ✅ Can increase when Binance sends message
- ❌ But user might read it immediately
- ❌ Multiple unrelated messages can arrive
- ❌ Can be reset without liveness completion
- **Verdict:** Don't rely on this for detection

### **6. Test Scripts - Run These FIRST**

Before implementing in handler, run these tests to understand behavior:

#### **Test 1: Liveness Complete Flow**
```bash
node scripts/test-liveness-complete.js <orderNumber>
```
**What it does:**
- Gets order (should have additionalKycVerify = 1)
- Calls verifyAdditionalKyc()
- Checks response.kycVerified
- Verifies status changed to 2

**When to use:** After buyer completes liveness on Binance

---

#### **Test 2: Polling Detection**
```bash
node scripts/test-polling-detection.js <orderNumber>
```
**What it does:**
- Starts polling loop (2 seconds interval, 2 minute max)
- Monitors additionalKycVerify changes
- When change detected (1→2), calls verifyAdditionalKyc()
- Confirms final status is 2

**When to use:** To simulate what the handler polling does

---

#### **Test 3: Endpoint Behavior**
```bash
node scripts/test-verify-endpoint.js <orderNumber>
```
**What it does:**
- Inspects verifyAdditionalKyc() response
- Shows ALL response fields
- Checks kycVerified indicator
- Verifies order status changed

**When to use:** To understand the endpoint response format

---

#### **Test All (Sequential)**
```bash
node scripts/test-all-scenarios.js <orderNumber>
```
**Runs all 3 tests in sequence**

---

### **7. Implementation Checklist**

After running tests, implement as follows:

```javascript
// In handler polling loop:

async function pollLiveness(orderNo) {
  let previousStatus = null;
  
  setInterval(async () => {
    const order = await getOrder(orderNo);
    
    // First poll: record initial
    if (previousStatus === null) {
      previousStatus = order.additionalKycVerify;
      return;
    }
    
    // Check if changed from 1 to 2
    if (previousStatus === 1 && order.additionalKycVerify === 2) {
      // ✅ Status already changed - just proceed
      await onLivenessCompleted(orderNo);
      clearInterval(this.poll);
    }
    else if (previousStatus === 1 && order.additionalKycVerify === 1) {
      // Still pending - try to verify
      try {
        const result = await verifyAdditionalKyc(orderNo);
        
        if (result.success && result.kycVerified === true) {
          // Wait 1 second for Binance to update
          await sleep(1000);
          
          const updated = await getOrder(orderNo);
          if (updated.additionalKycVerify === 2) {
            await onLivenessCompleted(orderNo);
            clearInterval(this.poll);
          }
        }
      } catch (err) {
        // Retry next poll
      }
    }
    
    previousStatus = order.additionalKycVerify;
  }, 5000); // 5 second interval
}
```

---

### **8. Success Criteria**

When polling detects liveness completion:

```javascript
✅ SUCCESS when ALL of:
  1. Previous additionalKycVerify was 1
  2. Current additionalKycVerify is 2
  3. (OR verifyAdditionalKyc response has kycVerified = true)
  4. Order proceeds to next state
  5. No errors thrown

⚠️ RETRY when:
  1. additionalKycVerify still 1
  2. verifyAdditionalKyc response success=false
  3. Continue polling next cycle

❌ TIMEOUT when:
  1. 10 minutes elapsed without change
  2. Send message to buyer
  3. Cancel order
```

---

### **9. Error Scenarios**

| Scenario | Cause | Handler Response |
|----------|-------|------------------|
| verifyAdditionalKyc fails | Liveness not actually completed | Log warning, continue polling |
| additionalKycVerify stays 1 | Buyer abandoned liveness | Continue polling, timeout after 10 min |
| additionalKycVerify becomes 0 | Ad requirements changed | Log error, proceed as not-required |
| additionalKycVerify becomes 2 (no call) | Binance completed it | Detect and proceed immediately |

---

### **10. Polling Strategy**

```
Interval:     5 seconds (not too aggressive, not too slow)
Max timeout:  10 minutes (buyer-friendly)
Comparison:   Monitor transitions (1→2), not absolute values
Verification: Call verifyAdditionalKyc only when needed
Confirmation: Re-fetch after verify to confirm status
Logging:      Log all state changes and verify attempts
```

---

## Quick Reference: Detection Logic

```javascript
// The simplest correct implementation:

const order = await getOrder(orderNo);

if (order.additionalKycVerify === 2) {
  // Already verified - proceed
  await onComplete(orderNo);
}
else if (order.additionalKycVerify === 1) {
  // Pending - we need to either:
  
  // Option A: Wait for external change (not recommended)
  // Option B: Try to verify (recommended)
  
  const result = await verifyAdditionalKyc(orderNo);
  
  if (result.success && result.kycVerified) {
    // Likely verified now
    await sleep(1000);
    
    const updated = await getOrder(orderNo);
    if (updated.additionalKycVerify === 2) {
      await onComplete(orderNo);
    }
  } else {
    // Not verified - continue polling
    // Buyer hasn't completed liveness yet
  }
}
else if (order.additionalKycVerify === 0) {
  // Not required - proceed immediately
  await onComplete(orderNo);
}
```

---

## Next Steps

1. **Run Test 1** with an order where buyer completed liveness
2. **Run Test 2** to simulate polling behavior
3. **Run Test 3** to inspect endpoint response
4. **Document findings** - what response fields indicate success?
5. **Implement** in handler based on test results
6. **Verify** with real orders end-to-end

---

## Files to Modify

After running tests and understanding behavior:

1. `src/seller/bot/sellerOrderHandler.js` - startLivenessPolling() method
2. `src/seller/bot/sellerOrderPoller.js` - order status logging (optional)

---

## Related Documentation

- Binance SAPI v7.4 Docs: `sapi-v7.4 (1).md`
- Endpoint: POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc
- Field: additionalKycVerify (0/1/2)
- Response: { success, kycVerified, ... }
