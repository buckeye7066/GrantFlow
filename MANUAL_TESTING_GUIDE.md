# Manual Testing Guide for Authentication Error Handling

## Prerequisites

Before testing, ensure you have:
- [ ] Cloned the repository
- [ ] Checked out the PR branch: `copilot/fix-login-page-502-error`
- [ ] Installed dependencies: `npm install`

## Test Suite

### Test 1: Health Endpoint Validation

**Objective:** Verify the health endpoint returns correct structure and status.

**Steps:**
1. Start the backend server:
   ```bash
   npm run backend
   ```

2. In a new terminal, test the health endpoint:
   ```bash
   curl http://localhost:8080/health | jq .
   ```

**Expected Result:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-06T...",
  "uptime": 123.45,
  "dependencies": {
    "database": "healthy",
    "openai": "configured" or "not configured"
  }
}
```

**Success Criteria:**
- [ ] Status code is 200
- [ ] Response contains all required fields
- [ ] Database shows as "healthy"
- [ ] Timestamp is recent

---

### Test 2: Diagnostics Endpoint Validation

**Objective:** Verify authentication diagnostics return provider configuration status.

**Steps:**
1. With backend still running, test diagnostics:
   ```bash
   curl http://localhost:8080/api/auth/diagnostics | jq .
   ```

**Expected Result:**
```json
{
  "status": "operational" or "degraded",
  "timestamp": "2026-01-06T...",
  "auth": {
    "jwtSecret": "configured",
    "routes": "registered",
    "database": "connected"
  },
  "providers": {
    "google": {
      "configured": true/false,
      "clientId": "present"/"missing",
      "clientSecret": "present"/"missing"
    },
    "facebook": { ... },
    "yahoo": { ... }
  }
}
```

**Success Criteria:**
- [ ] Status code is 200 or 503 (degraded)
- [ ] All three providers are listed
- [ ] Configuration status matches environment variables
- [ ] Database shows as "connected"

---

### Test 3: Automated Smoke Tests

**Objective:** Run automated tests for all new endpoints.

**Steps:**
1. With backend running, execute smoke tests:
   ```bash
   npm run smoke:auth-diagnostics
   ```

**Expected Output:**
```
[test] Starting authentication error handling smoke tests
[test] API Base URL: http://localhost:8080

[test] Testing /health endpoint...
[test] ✅ Health endpoint test passed

[test] Testing /api/auth/diagnostics endpoint...
[test] google configured: true/false
[test] facebook configured: true/false
[test] yahoo configured: true/false
[test] ✅ Auth diagnostics endpoint test passed

[test] Testing OAuth start endpoints...
[test] ✅ OAuth start endpoint test passed

[test] ========================================
[test] Test Summary:
[test] Passed: 3/3
[test] ✅ All tests passed!
```

**Success Criteria:**
- [ ] All 3 tests pass
- [ ] No errors or exceptions
- [ ] Provider configurations are correctly reported

---

### Test 4: UI - Backend Unavailable

**Objective:** Verify UI displays correct error when backend is not running.

**Steps:**
1. **Stop the backend server** (if running)
2. Start the frontend:
   ```bash
   npm run dev
   ```
3. Open browser to `http://localhost:5173/grantflow/login`
4. Click on "Continue with Google" button
5. Observe the error message

**Expected UI Behavior:**
- [ ] Loading spinner appears briefly
- [ ] Error message appears in a red/rose-colored box
- [ ] Error message says "Backend Server Unavailable"
- [ ] Error message includes bullet points:
  - "Ensure the backend server is running"
  - "Check your network connection"
  - "Verify the API URL configuration"
- [ ] "Try Again" button is visible and clickable
- [ ] Other provider buttons are disabled
- [ ] Console shows: `[SocialSignIn] Backend health check failed`

**Screenshot Required:** Yes, capture the error message.

---

### Test 5: UI - Provider Not Configured

**Objective:** Verify UI shows correct error when OAuth provider is not configured.

**Steps:**
1. Ensure backend is running WITHOUT OAuth credentials:
   - Remove or comment out `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `.env`
   - Restart backend: `npm run backend`

2. In browser, click "Continue with Google"

**Expected UI Behavior:**
- [ ] "checking..." loading state appears
- [ ] Error message appears
- [ ] Error says "Provider Not Configured"
- [ ] Message mentions "Continue with Google is not configured"
- [ ] Instructs to "contact your administrator"
- [ ] "Try Again" button is visible
- [ ] Console shows: `[SocialSignIn] Auth diagnostics: { ... }`

**Screenshot Required:** Yes, capture the provider error.

---

### Test 6: UI - Network Timeout Simulation

**Objective:** Verify retry mechanism works correctly.

**Steps:**
1. With backend running, use browser DevTools to throttle network:
   - Open DevTools (F12)
   - Go to Network tab
   - Select "Slow 3G" or "Offline" throttling

2. Click "Continue with Google"

**Expected UI Behavior:**
- [ ] "checking..." state appears
- [ ] After timeout, message shows "Connection failed. Retrying... (1/2)"
- [ ] Retry happens automatically after 2 seconds
- [ ] If still failing, shows "Retrying... (2/2)"
- [ ] After max retries, shows final error message
- [ ] Console shows multiple `[SocialSignIn]` log entries with attempt numbers

**Screenshot Required:** Yes, capture the retry state.

---

### Test 7: UI - Successful Authentication Flow

**Objective:** Verify normal flow works when everything is configured.

**Steps:**
1. Ensure backend is running WITH OAuth credentials configured:
   ```bash
   # In .env file:
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
   
2. Restart backend if needed

3. Click "Continue with Google"

**Expected UI Behavior:**
- [ ] "checking..." state appears briefly
- [ ] Button changes to "redirecting…" state
- [ ] Browser redirects to Google OAuth page
- [ ] No error messages appear
- [ ] Console shows:
   ```
   [SocialSignIn] Starting google authentication (attempt 1/3)
   [SocialSignIn] Redirecting to: http://localhost:8080/api/auth/google/start...
   ```

**Screenshot Required:** Optional, but helpful to see the loading state.

---

### Test 8: Error Boundary - Unexpected Error

**Objective:** Verify error boundary catches React errors gracefully.

**Steps:**
1. Temporarily modify `SocialSignInButtons.jsx` to throw an error:
   ```javascript
   // Add this line at the start of handleClick function:
   throw new Error('Test error boundary');
   ```

2. Click any OAuth provider button

**Expected UI Behavior:**
- [ ] Full error boundary UI appears
- [ ] Shows "Authentication Error" heading
- [ ] Shows generic error message
- [ ] "Try Again" button is visible
- [ ] "Reload Page" button is visible
- [ ] In development mode, technical details are visible
- [ ] Technical details show the error message and stack trace

**Important:** Remove the test error after verification!

**Screenshot Required:** Yes, capture the error boundary UI.

---

### Test 9: Backend Logging

**Objective:** Verify backend logs contain useful debugging information.

**Steps:**
1. Start backend and monitor logs:
   ```bash
   npm run backend | grep "\[auth\]"
   ```

2. Trigger various scenarios (provider not configured, etc.)

**Expected Log Output:**
```
[auth] OAuth start requested for provider: google
[auth] OAuth provider google not configured (missing client ID or secret)
[auth] Google OAuth start status: 503
```

**Success Criteria:**
- [ ] All auth requests are logged
- [ ] Provider names are included
- [ ] Configuration errors are logged
- [ ] Success cases are logged

---

### Test 10: Diagnostics with Multiple Providers

**Objective:** Verify diagnostics correctly reports mixed configurations.

**Steps:**
1. Configure only one provider (e.g., Google) in `.env`
2. Restart backend
3. Call diagnostics endpoint

**Expected Result:**
```json
{
  "providers": {
    "google": { "configured": true, ... },
    "facebook": { "configured": false, ... },
    "yahoo": { "configured": false, ... }
  }
}
```

**Success Criteria:**
- [ ] Google shows as configured
- [ ] Facebook shows as not configured
- [ ] Yahoo shows as not configured
- [ ] Overall status reflects configuration state

---

## Test Results Template

Copy and fill out this template with your results:

```markdown
## Test Results

Date: _______________
Tester: _______________
Branch: copilot/fix-login-page-502-error
Commit: _______________

### Test 1: Health Endpoint
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Test 2: Diagnostics Endpoint
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Test 3: Automated Smoke Tests
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Test 4: Backend Unavailable UI
- Status: ✅ PASS / ❌ FAIL
- Screenshot: [link or attach]
- Notes: _____________________

### Test 5: Provider Not Configured UI
- Status: ✅ PASS / ❌ FAIL
- Screenshot: [link or attach]
- Notes: _____________________

### Test 6: Network Timeout UI
- Status: ✅ PASS / ❌ FAIL
- Screenshot: [link or attach]
- Notes: _____________________

### Test 7: Successful Authentication
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Test 8: Error Boundary
- Status: ✅ PASS / ❌ FAIL
- Screenshot: [link or attach]
- Notes: _____________________

### Test 9: Backend Logging
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Test 10: Mixed Provider Configuration
- Status: ✅ PASS / ❌ FAIL
- Notes: _____________________

### Overall Result
- Total Passed: _____ / 10
- Ready for Production: ✅ YES / ❌ NO
- Additional Comments: _____________________
```

---

## Troubleshooting

### Issue: Backend won't start
**Solution:** Check if all dependencies are installed:
```bash
npm install
```

### Issue: Port 8080 already in use
**Solution:** Kill the process using port 8080:
```bash
lsof -ti:8080 | xargs kill -9
```

### Issue: Frontend can't connect to backend
**Solution:** Verify `VITE_API_URL` in your `.env` file:
```
VITE_API_URL=http://localhost:8080
```

### Issue: OAuth redirect fails
**Solution:** Check that OAuth credentials are valid and callback URLs are configured correctly in the OAuth provider's dashboard.

---

## Sign-off

Once all tests pass and screenshots are captured:

- [ ] All automated tests pass
- [ ] All manual UI tests completed
- [ ] Screenshots captured for visual verification
- [ ] Backend logging verified
- [ ] No console errors in browser
- [ ] Ready for merge and deployment

Tested by: _______________
Date: _______________
Signature: _______________
