# Liveness Detection - Test Scenarios Summary

## Complete Testing Strategy

Based on Binance API v7.4 research, here are all test scenarios to validate liveness detection works correctly.

---

## **SCENARIO 1: Liveness Complete Flow**

**File:** `scripts/test-liveness-complete.js`

**Command:**
```bash
node scripts/test-liveness-complete.js <orderNumber>
```

**What it tests:**
1. Order has `additionalKycVerify = 1` (pending)
2. Call `verifyAdditionalKyc(orderNumber)`
3. Check response: `kycVerified = true`
4. Re-fetch order: `additionalKycVerify` should be `2`
5. Verify state transition: `1 → 2`

**Expected Output:**
```
STEP 1: Fetching initial order status...
  additionalKycVerify: 1

STEP 2: Calling verifyAdditionalKyc()...
  Status: ✅ Success
  kycVerified: true

STEP 3: Waiting 2 seconds then re-fetching...
  additionalKycVerify: 2

STEP 4: Verification
✅ SUCCESS: additionalKycVerify changed 1 → 2
   Liveness is now VERIFIED
```

**When to run:**
- After buyer completes liveness on Binance
- To verify endpoint works correctly
- **Prerequisite:** Order must have `additionalKycVerify = 1`

**Pass Criteria:**
- ✅ verifyAdditionalKyc returns `success: true`
- ✅ Response includes `kycVerified: true`
- ✅ Order status updates to `additionalKycVerify = 2`
- ✅ No errors thrown

---

## **SCENARIO 2: Polling Detection Flow**

**File:** `scripts/test-polling-detection.js`

**Command:**
```bash
node scripts/test-polling-detection.js <orderNumber>
```

**What it tests:**
1. Start polling loop (every 2 seconds)
2. Track previous `additionalKycVerify` value
3. Detect when status changes (`1 → 2`)
4. Call `verifyAdditionalKyc()` when change detected
5. Confirm final status is `2`

**Expected Output:**
```
Starting polling... (max 2 minutes)

[10:00:01 AM] Poll #1: Initial state = 1
[10:00:03 AM] Poll #2: No change (still 1)
[10:00:05 AM] Poll #3: No change (still 1)
...
[10:00:47 AM] Poll #14: ✨ CHANGE DETECTED!
   1 → 2
   Calling verifyAdditionalKyc()...
   
   verifyAdditionalKyc Response:
   - Status: ✅ Success
   - kycVerified: true
   
   After verify - additionalKycVerify: 2

✅ SUCCESS: Liveness verified (1 → 2)
```

**When to run:**
- To test polling mechanism
- To simulate handler behavior
- During liveness verification wait period
- **Prerequisite:** Order must have `additionalKycVerify = 1`

**Pass Criteria:**
- ✅ Polling detects status change
- ✅ Calls verifyAdditionalKyc on change
- ✅ Confirms status updated to 2
- ✅ Completes within timeout

---

## **SCENARIO 3: Endpoint Behavior Analysis**

**File:** `scripts/test-verify-endpoint.js`

**Command:**
```bash
node scripts/test-verify-endpoint.js <orderNumber>
```

**What it tests:**
1. Inspect `verifyAdditionalKyc()` response format
2. Check all response fields
3. Verify `kycVerified` field reliability
4. Confirm order status updates
5. Document endpoint behavior

**Expected Output:**
```
STEP 1: Getting current status...
  additionalKycVerify: 1
  All KYC-related fields:
    - additionalKycVerify: 1
    - kycVerified: undefined

STEP 2: Calling verifyAdditionalKyc()...

STEP 3: Response Analysis
  Full Response: {
    "success": true,
    "code": "000000",
    "message": "success",
    "kycVerified": true,
    "orderNumber": "22909..."
  }

STEP 4: Success Indicators
  response.success: true
  response.kycVerified: true
  response.code: 000000
  response.message: success

STEP 5: Verifying order status changed...
  Before: additionalKycVerify = 1
  After:  additionalKycVerify = 2

✅ SUCCESS: Order status updated to 2 (VERIFIED)
   Endpoint worked correctly

RECOMMENDATIONS:
  1. Use response.success to detect if verify was attempted
  2. Use response.kycVerified to confirm liveness was verified
  3. Re-fetch order to confirm additionalKycVerify changed to 2
  4. Consider response success + re-fetch confirmation as final check
```

**When to run:**
- To understand endpoint response format
- To debug endpoint failures
- To document expected behavior
- **Prerequisite:** Any order with `additionalKycVerify = 1`

**Pass Criteria:**
- ✅ Response includes `success` field
- ✅ Response includes `kycVerified` field
- ✅ Order status updates after call
- ✅ All response fields are present and valid

---

## **SCENARIO 4: Error Handling - Liveness Not Completed**

**Manual test (no script)**

**Test:** Call verifyAdditionalKyc when buyer HASN'T completed liveness

**Expected Behavior:**
```
When calling verifyAdditionalKyc on pending liveness:

Response: {
  "success": false,
  "code": "-1",
  "message": "Liveness not completed" (or similar)
}

additionalKycVerify: remains 1 (no change)
kycVerified: false or undefined

Handler should:
  ✅ Detect response.success = false
  ✅ Log warning/info
  ✅ Continue polling (retry next cycle)
  ✅ Don't proceed with order
  ✅ Eventually timeout after 10 minutes
```

**How to test:**
1. Create order with liveness requirement
2. Don't complete liveness on Binance
3. Immediately call verifyAdditionalKyc
4. Observe error response

**Pass Criteria:**
- ✅ Error returned gracefully
- ✅ Order state remains valid
- ✅ Polling can retry
- ✅ No crashes or hangs

---

## **SCENARIO 5: Error Handling - API Failure**

**Manual test (no script)**

**Test:** Network/API errors during polling

**Expected Behavior:**
```
When network fails or API is down:

Polling should:
  ✅ Catch exception
  ✅ Log error
  ✅ Continue polling next cycle
  ✅ Don't update state
  ✅ Don't proceed with order

After API recovers:
  ✅ Resume normal polling
  ✅ Detect liveness completion
  ✅ Proceed normally
```

**How to test:**
1. Start polling for liveness
2. Disable network or API access
3. Observe error handling
4. Re-enable network
5. Verify polling resumes

**Pass Criteria:**
- ✅ Errors caught and logged
- ✅ Polling continues despite errors
- ✅ Recovery automatic
- ✅ No state corruption

---

## **SCENARIO 6: Timeout Handling**

**Manual test (no script)**

**Test:** Liveness completion timeout (10 minutes)

**Expected Behavior:**
```
After 10 minutes without liveness completion:

Handler should:
  ✅ Stop polling
  ✅ Set order state to LIVENESS_TIMEOUT
  ✅ Send message to buyer: "Liveness check timeout. Order cancelled."
  ✅ Log timeout event
  ✅ Don't proceed with order
  ✅ Cleanup timers and intervals
```

**How to test:**
1. Create order with liveness requirement
2. Don't complete liveness on Binance
3. Wait 10+ minutes
4. Observe timeout handling
5. Check order state in database

**Pass Criteria:**
- ✅ Polling stops after timeout
- ✅ Order state set to TIMEOUT
- ✅ Message sent to buyer
- ✅ No memory leaks (timers cleared)

---

## **SCENARIO 7: Already Verified Orders**

**Manual test (no script)**

**Test:** Order arrives with `additionalKycVerify = 2`

**Expected Behavior:**
```
When order already has additionalKycVerify = 2:

Handler should:
  ✅ Detect already verified
  ✅ Skip liveness verification
  ✅ Proceed directly to payment
  ✅ Don't start polling
  ✅ Don't call verifyAdditionalKyc
```

**How to test:**
1. Manually set `additionalKycVerify = 2` in database
2. Create/place order with this state
3. Observe handler behavior
4. Verify it proceeds without waiting

**Pass Criteria:**
- ✅ No polling starts
- ✅ Immediately proceeds
- ✅ No unnecessary API calls
- ✅ Order processes normally

---

## **Running All Tests**

**Command to run all tests sequentially:**
```bash
node scripts/test-all-scenarios.js <orderNumber>
```

**Output Summary:**
```
Test Results:
  TEST 1: Liveness Complete ........................ ✅/❌
  TEST 2: Polling Detection (2 min max) ........... ✅/❌
  TEST 3: Endpoint Behavior ........................ ✅/❌

Overall: X passed, Y failed
```

---

## **Test Execution Order**

**Recommended order for first-time testing:**

1. **TEST 1: Liveness Complete** (quick, 10 seconds)
   - Verify basic functionality

2. **TEST 3: Endpoint Behavior** (quick, 5 seconds)
   - Understand response format

3. **TEST 2: Polling Detection** (slow, 2 minutes max)
   - Test full detection flow

4. **Manual scenarios** (optional, 20+ minutes)
   - Error cases
   - Timeouts
   - Edge cases

---

## **Success Criteria for All Tests**

Before implementation is considered correct:

- ✅ **TEST 1 passes** - verifyAdditionalKyc works correctly
- ✅ **TEST 2 passes** - Polling detects state changes
- ✅ **TEST 3 passes** - Endpoint response is understood
- ✅ **Manual tests** - Error handling works
- ✅ **No crashes** - All error paths handled gracefully
- ✅ **Logging** - All important events logged
- ✅ **Timeouts** - Cleanup and cancellation work
- ✅ **Real orders** - End-to-end flow works with actual Binance orders

---

## **After Tests Pass**

Implement in handler:
1. `startLivenessPolling()` - Main polling loop
2. Detect state changes (1 → 2)
3. Call `verifyAdditionalKyc()` when needed
4. Handle errors and timeouts
5. Proceed to payment/order verification

See `LIVENESS_DETECTION_GUIDE.md` for implementation details.
