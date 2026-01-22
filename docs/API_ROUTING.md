# API Routing Architecture

## Overview

GrantFlow uses a split deployment architecture:
- **Frontend**: Static assets served by Vercel (HTML, JS, CSS)
- **Backend**: Express API server running on Railway (Node.js)

## How API Routing Works

### Production (Vercel + Railway)

1. **Vercel** serves the frontend at `https://app.axiombiolabs.org/grantflow`
2. **vercel.json rewrites** proxy all API requests to Railway:
   - `/api/:path*` → `https://grantflow-production.up.railway.app/api/:path*`
   - `/grantflow/api/:path*` → `https://grantflow-production.up.railway.app/api/:path*`
   - `/uploads/:path*` → `https://grantflow-production.up.railway.app/uploads/:path*`

3. Frontend makes **same-origin** API calls to `/api/*` (relative URLs)
4. Vercel transparently forwards these to Railway backend
5. **No CORS issues** because from the browser's perspective, it's same-origin

### Why This Matters for Authentication & Email

**CRITICAL: Auth and email logic runs on Railway, NOT Vercel.**

- Email-based OTP login (`/api/auth/email/start`, `/api/auth/email/verify`) runs on Railway
- **Resend email service** is configured and runs on Railway
- Environment variables for email (`RESEND_API_KEY`, `FROM_EMAIL`) **must be set in Railway**
- Setting these in Vercel does nothing, because Vercel only serves static assets

### Request Flow for Email OTP Login

```
Browser (frontend)
  ↓ POST /api/auth/email/start
  ↓
Vercel (sees request to /api/*)
  ↓ (rewrites via vercel.json)
  ↓
Railway Backend (backend/routes/auth.js)
  ↓ calls backend/services/email.js
  ↓
Resend API (sends email)
```

## Development

In local development:
- Frontend runs on `http://localhost:5173`
- Backend runs on `http://localhost:8080`
- Vite dev server proxies `/api/*` to backend (configured in `vite.config.ts`)
- Or set `VITE_API_URL=http://localhost:8080` to hit backend directly

## Configuration Files

- **vercel.json**: Defines API rewrites to Railway backend
- **src/api/client.js**: Frontend API client that uses same-origin `/api/*` in production
- **vite.config.ts**: Dev server proxy configuration
- **docs/ENVIRONMENT.md**: Full list of environment variables and where to set them

## Troubleshooting

### Email OTP not working in production?

1. **Check Railway environment variables** (not Vercel):
   - `RESEND_API_KEY` - Must be set
   - `FROM_EMAIL` or `EMAIL_FROM` - Must be a verified domain in Resend
   - `AUTH_JWT_SECRET` - Required for auth tokens

2. **Check Railway logs** for email sending errors:
   - Look for `[email/sendVerificationEmail]` log messages
   - Should see `provider: resend, runtime: railway`

3. **Verify Resend dashboard**:
   - Domain is verified
   - API key is valid
   - FROM_EMAIL matches verified domain

### How to verify routing is correct?

1. Open browser dev tools → Network tab
2. Login with email OTP
3. Check the request to `/api/auth/email/start`
   - Should be same-origin (no CORS preflight)
   - Response should come from Railway (check response headers)

### Admin failsafe for email failures

If email delivery fails and you need to log in as admin:

1. Set `AUTH_ALLOW_ADMIN_PREVIEW_CODE=true` in Railway
2. Login will return `previewCode` in response for admin users only
3. This does NOT weaken security for non-admin users
4. Only works for emails in `ADMIN_EMAIL` or `ADMIN_EMAILS` env var

## Security Notes

- OTP codes are never returned in production responses (except admin failsafe)
- Email logic runs server-side on Railway (not client-side on Vercel)
- Same-origin proxy prevents CORS attacks
- JWT tokens are signed with `AUTH_JWT_SECRET` on Railway backend
