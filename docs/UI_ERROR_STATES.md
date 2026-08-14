# UI Error States - Visual Examples

This document shows what users will see when encountering various error scenarios.

## Scenario 1: Backend Server Not Running

When the backend is unavailable, users see:

```
┌────────────────────────────────────────────────────────────┐
│                   Sign in to GrantFlow                     │
│           Enter your email address to get started.         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ℹ️  We'll email you a one-time link to set your          │
│     password on first sign-in.                             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│  Prefer single sign-on? Connect with Google, Facebook, or │
│  Yahoo. We'll route you back here once your provider       │
│  verifies your identity.                                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  ⚠️  Backend Server Unavailable                      │ │
│  │                                                       │ │
│  │  The authentication server is not responding.        │ │
│  │  Please:                                             │ │
│  │  • Ensure the backend server is running             │ │
│  │  • Check your network connection                    │ │
│  │  • Verify the API URL configuration                 │ │
│  │                                                       │ │
│  │  [ 🔄 Try Again ]                                    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                             │
│  [ 🌐 Continue with Google ] (disabled)                   │
│  [ 📘 Continue with Facebook ] (disabled)                 │
│  [ 💼 Continue with Yahoo ] (disabled)                    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Scenario 2: OAuth Provider Not Configured

When OAuth credentials are missing:

```
┌────────────────────────────────────────────────────────────┐
│                   Sign in to GrantFlow                     │
│           Enter your email address to get started.         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Prefer single sign-on? Connect with Google, Facebook, or │
│  Yahoo. We'll route you back here once your provider       │
│  verifies your identity.                                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  ⚠️  Provider Not Configured                         │ │
│  │                                                       │ │
│  │  Continue with Google is not configured on the       │ │
│  │  server. Please contact your administrator to set    │ │
│  │  up OAuth credentials.                               │ │
│  │                                                       │ │
│  │  [ 🔄 Try Again ]                                    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                             │
│  [ 🌐 Continue with Google ] (disabled)                   │
│  [ 📘 Continue with Facebook ]                             │
│  [ 💼 Continue with Yahoo ]                                │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Scenario 3: Network Timeout with Retry

When experiencing network issues:

```
┌────────────────────────────────────────────────────────────┐
│                   Sign in to GrantFlow                     │
│           Enter your email address to get started.         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Prefer single sign-on? Connect with Google, Facebook, or │
│  Yahoo. We'll route you back here once your provider       │
│  verifies your identity.                                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  ℹ️  Connection failed. Retrying... (1/2)            │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                             │
│  [ 🔄 Continue with Google ] (loading - checking...)      │
│  [ 📘 Continue with Facebook ] (disabled)                 │
│  [ 💼 Continue with Yahoo ] (disabled)                    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Scenario 4: Successful Authentication Start

When everything is working correctly:

```
┌────────────────────────────────────────────────────────────┐
│                   Sign in to GrantFlow                     │
│           Enter your email address to get started.         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ℹ️  We'll email you a one-time link to set your          │
│     password on first sign-in.                             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│  Prefer single sign-on? Connect with Google, Facebook, or │
│  Yahoo. We'll route you back here once your provider       │
│  verifies your identity.                                   │
│                                                             │
│  [ 🔄 Continue with Google ] (loading - redirecting…)     │
│  [ 📘 Continue with Facebook ] (disabled)                 │
│  [ 💼 Continue with Yahoo ] (disabled)                    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Scenario 5: React Error Boundary Catch

When an unexpected React error occurs:

```
┌────────────────────────────────────────────────────────────┐
│                                                             │
│                      ⛔                                     │
│                                                             │
│              Authentication Error                          │
│                                                             │
│  An unexpected error occurred during authentication.       │
│  Please try again or contact support if the problem        │
│  persists.                                                 │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │          [ 🔄 Try Again ]                          │   │
│  └────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │          [ ↻ Reload Page ]                         │   │
│  └────────────────────────────────────────────────────┘   │
│                                                             │
│  ▼ Technical Details (dev mode only)                      │
│  ┌────────────────────────────────────────────────────┐   │
│  │ TypeError: Cannot read property 'id' of undefined  │   │
│  │   at SocialSignInButtons.jsx:42                    │   │
│  │   at Login.jsx:15                                  │   │
│  └────────────────────────────────────────────────────┘   │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Scenario 6: 502 Bad Gateway Error

When the server returns a 502:

```
┌────────────────────────────────────────────────────────────┐
│                   Sign in to GrantFlow                     │
│           Enter your email address to get started.         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Prefer single sign-on? Connect with Google, Facebook, or │
│  Yahoo. We'll route you back here once your provider       │
│  verifies your identity.                                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  ⚠️  Server Error (502)                              │ │
│  │                                                       │ │
│  │  The authentication server returned an error. Please │ │
│  │  try again or contact support.                       │ │
│  │                                                       │ │
│  │  [ 🔄 Try Again ]                                    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                             │
│  [ 🌐 Continue with Google ]                               │
│  [ 📘 Continue with Facebook ]                             │
│  [ 💼 Continue with Yahoo ]                                │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Button States

### Default State
```
┌─────────────────────────────────────┐
│ 🌐  Continue with Google            │
└─────────────────────────────────────┘
```

### Checking Backend State
```
┌─────────────────────────────────────┐
│ 🔄  Continue with Google  checking…│
└─────────────────────────────────────┘
```

### Redirecting State
```
┌─────────────────────────────────────┐
│ 🔄  Continue with Google  redirecting…│
└─────────────────────────────────────┘
```

### Retrying State
```
┌─────────────────────────────────────┐
│ 🔄  Continue with Google  redirecting (1/2)│
└─────────────────────────────────────┘
```

### Disabled State (when another provider is active)
```
┌─────────────────────────────────────┐
│ 📘  Continue with Facebook (grayed)│
└─────────────────────────────────────┘
```

## Color Scheme

### Error Messages
- **Border:** rose-200 (#fecdd3)
- **Background:** rose-50 (#fef2f2)
- **Text:** rose-900 (#881337)
- **Icon:** rose-600 (#e11d48)

### Info Messages
- **Border:** blue-100 (#dbeafe)
- **Background:** blue-50/70 (#eff6ff with 70% opacity)
- **Text:** slate-700 (#334155)

### Buttons
- **Primary (Try Again):** Default button styling
- **Secondary (Reload):** Outline variant
- **Loading:** Opacity 80%, spinner animation

## Accessibility Features

All error messages include:
- ✅ Semantic HTML with proper ARIA roles
- ✅ Sufficient color contrast (WCAG AA)
- ✅ Keyboard navigation support
- ✅ Screen reader friendly text
- ✅ Focus indicators on all interactive elements
- ✅ Clear visual hierarchy

## Responsive Behavior

### Desktop (≥768px)
- Error messages: Full width with padding
- Buttons: Full width stack
- Text: 14px (0.875rem)

### Mobile (<768px)
- Error messages: Condensed padding
- Buttons: Full width stack
- Text: Slightly smaller for readability
- Touch-friendly button sizes (min 44px height)

## Animation States

1. **Error Appears:** Fade in (0.2s ease)
2. **Loading Spinner:** Rotate animation (1s linear infinite)
3. **Button Hover:** Scale 1.02, transition 0.15s
4. **Button Press:** Scale 0.98

## Console Logging Examples

Users and developers will see helpful logs:

```javascript
// Successful flow
[SocialSignIn] Starting google authentication (attempt 1/3)
[SocialSignIn] Auth diagnostics: { status: 'operational', ... }
[SocialSignIn] Redirecting to: http://localhost:8080/api/auth/google/start

// Error flow
[SocialSignIn] Starting google authentication (attempt 1/3)
[SocialSignIn] Backend health check failed: TypeError: Failed to fetch
[SocialSignIn] Failed to start google login: Backend server is not responding
```

## Developer Tools Integration

The public flow provides health and OAuth-start status in browser DevTools. Detailed auth diagnostics are admin-only.

**Network Tab:**
```
GET /api/health
Status: 200 OK
Response: { "status": "healthy", "dependencies": { ... } }

GET /api/auth/diagnostics
Status: 401 Unauthorized unless admin-authenticated

GET /api/auth/google/start
Status: 302 Redirect or 503 Provider Not Configured
```

**Console Tab:**
```
[SocialSignIn] Starting google authentication (attempt 1/3)
[SocialSignIn] Redirecting to: http://localhost:8080/api/auth/google/start
```

This comprehensive error handling ensures users always know what's happening and what they can do to resolve issues!
