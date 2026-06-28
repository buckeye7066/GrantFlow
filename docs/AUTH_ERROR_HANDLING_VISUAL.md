# Authentication Error Handling - Visual Guide

## Error Handling Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     User Clicks OAuth Button                       │
│                    (Google/Facebook/Yahoo)                          │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│          SocialSignInButtons Component (Enhanced)                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Step 1: Check Backend Health                                  │ │
│  │   GET /api/health                                             │ │
│  │   Timeout: 5 seconds                                          │ │
│  └────────────┬──────────────────────────────────────────────────┘ │
│               │                                                      │
│               ▼                                                      │
│         ┌───────────┐                                               │
│         │ Healthy?  │                                               │
│         └───┬───┬───┘                                               │
│             │   │                                                    │
│         Yes │   │ No                                                │
│             │   │                                                    │
│             │   └──► ❌ Show "Backend Unavailable" Error            │
│             │         • Retry up to 2 times with 2s delay           │
│             │         • Show actionable instructions                │
│             │                                                        │
│             ▼                                                        │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Step 2: Check Provider Configuration                          │ │
│  │   GET /api/auth/diagnostics                                   │ │
│  │   Timeout: 5 seconds                                          │ │
│  └────────────┬──────────────────────────────────────────────────┘ │
│               │                                                      │
│               ▼                                                      │
│         ┌───────────────┐                                           │
│         │ Configured?   │                                           │
│         └───┬───┬───────┘                                           │
│             │   │                                                    │
│         Yes │   │ No                                                │
│             │   │                                                    │
│             │   └──► ⚠️  Show "Provider Not Configured" Error       │
│             │         • Guide user to contact administrator         │
│             │         • List missing OAuth credentials              │
│             │                                                        │
│             ▼                                                        │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Step 3: Redirect to OAuth Provider                            │ │
│  │   window.location.href = /api/auth/{provider}/start           │ │
│  └────────────┬──────────────────────────────────────────────────┘ │
└───────────────┼──────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Backend: /api/auth/:provider/start                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Enhanced Error Handling:                                      │ │
│  │ • Validate provider exists (404 if not)                       │ │
│  │ • Check OAuth credentials configured (503 if not)             │ │
│  │ • Log all requests with provider name                         │ │
│  │ • Wrap in try-catch for unexpected errors                     │ │
│  │ • Return detailed error messages                              │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  Success: 302 Redirect to OAuth Provider ──────────────────►         │
│  Error: 404/503/500 with JSON error response                        │
└───────────────────────────────────────────────────────────────────────┘
```

## Error Boundary Protection

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Login Page                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │              AuthErrorBoundary                                │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │           AuthShell                                      │ │ │
│  │  │  ┌───────────────────────────────────────────────────┐  │ │ │
│  │  │  │        AuthMethodTabs                             │  │ │ │
│  │  │  │  ┌─────────────────────────────────────────────┐  │  │ │ │
│  │  │  │  │    SocialSignInButtons                      │  │  │ │ │
│  │  │  │  │    (with built-in error handling)           │  │  │ │ │
│  │  │  │  └─────────────────────────────────────────────┘  │  │ │ │
│  │  │  └───────────────────────────────────────────────────┘  │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                                                               │ │
│  │  If any unhandled error occurs:                              │ │
│  │  • Display user-friendly error message                       │ │
│  │  • Show "Try Again" and "Reload Page" buttons                │ │
│  │  • Log technical details (dev mode only)                     │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Error Message Examples

### 1. Backend Server Unavailable
```
┌──────────────────────────────────────────────────┐
│  ⚠️  Backend Server Unavailable                  │
│                                                   │
│  The authentication server is not responding.    │
│  Please:                                         │
│  • Ensure the backend server is running         │
│  • Check your network connection                │
│  • Verify the API URL configuration             │
│                                                   │
│  [ 🔄 Try Again ]                                │
└──────────────────────────────────────────────────┘
```

### 2. Provider Not Configured
```
┌──────────────────────────────────────────────────┐
│  ⚠️  Provider Not Configured                     │
│                                                   │
│  Continue with Google is not configured on the   │
│  server. Please contact your administrator to    │
│  set up OAuth credentials.                       │
│                                                   │
│  [ 🔄 Try Again ]                                │
└──────────────────────────────────────────────────┘
```

### 3. Server Error (502)
```
┌──────────────────────────────────────────────────┐
│  ⚠️  Server Error (502)                          │
│                                                   │
│  The authentication server returned an error.    │
│  Please try again or contact support.            │
│                                                   │
│  [ 🔄 Try Again ]                                │
└──────────────────────────────────────────────────┘
```

### 4. Retrying Connection
```
┌──────────────────────────────────────────────────┐
│  ℹ️  Connection failed. Retrying... (1/2)        │
└──────────────────────────────────────────────────┘
```

## Diagnostic Endpoints

### GET /api/health
Returns overall system health status

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-06T00:22:56.963Z",
  "uptime": 123.456,
  "dependencies": {
    "database": "healthy",
    "openai": "configured"
  }
}
```

### GET /api/auth/diagnostics
Returns authentication system configuration status for authenticated admins. Unauthenticated requests should return 401/403.

**Response:**
```json
{
  "status": "operational",
  "timestamp": "2026-01-06T00:22:56.963Z",
  "auth": {
    "jwtSecret": "configured",
    "routes": "registered",
    "database": "connected"
  },
  "providers": {
    "google": {
      "configured": true,
      "clientId": "present",
      "clientSecret": "present"
    },
    "facebook": {
      "configured": false,
      "clientId": "missing",
      "clientSecret": "missing"
    },
    "yahoo": {
      "configured": false,
      "clientId": "missing",
      "clientSecret": "missing"
    }
  }
}
```

## Testing

### Run Smoke Tests
```bash
# Start the backend
npm run backend

# In another terminal, run diagnostics tests
npm run smoke:auth-diagnostics
```

### Expected Output
```
[test] Starting authentication error handling smoke tests
[test] API Base URL: http://localhost:8080

[test] Testing /api/health endpoint...
[test] Health endpoint status: 200
[test] ✅ Health endpoint test passed

[test] Testing /api/auth/diagnostics endpoint...
[test] Diagnostics endpoint status: 401
[test] PASS Auth diagnostics correctly require admin authentication
[test] ✅ Auth diagnostics endpoint test passed

[test] Testing OAuth start endpoints...
[test] Unsupported provider status: 404
[test] Google OAuth start status: 503
[test] ✅ OAuth start endpoint test passed

[test] ========================================
[test] Test Summary:
[test] Passed: 3/3
[test] ✅ All tests passed!
```

## Development Quick Reference

### Enable Debug Logging
Frontend logging is automatic. Check browser console for:
- `[SocialSignIn]` - Social authentication flow
- `[AuthErrorBoundary]` - Error boundary catches

Backend logging shows:
- `[auth]` - Authentication route activity

### Common Issues and Solutions

| Issue | Likely Cause | Solution |
|-------|--------------|----------|
| "Backend Unavailable" | Server not running | Start backend with `npm run backend` |
| "Provider Not Configured" | Missing OAuth credentials | Set environment variables for provider |
| Retry loop (multiple attempts) | Network timeout | Check firewall/proxy settings |
| 404 on OAuth route | Wrong provider name | Verify provider is in OAUTH_PROVIDERS list |

### Adding Custom Error Messages
Edit `SocialSignInButtons.jsx`, function `getErrorMessage()`:

```javascript
if (message.includes('your-error-pattern')) {
  return (
    <div className="space-y-2">
      <p className="font-semibold">Custom Error Title</p>
      <p>Custom instructions for users</p>
    </div>
  )
}
```
