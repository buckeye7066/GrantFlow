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
- **Email delivery is optional** - OTP codes are returned directly for authorized users
- In production, only emails matching existing profiles can log in (profile-email gated access)
- Admins can always log in (emails in `ADMIN_EMAIL` or `ADMIN_EMAILS`)
- Environment variables for email (`RESEND_API_KEY`, `FROM_EMAIL`) **must be set in Railway** if you want email notifications
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
  ↓ checks if email matches existing profile (production only)
  ↓ generates OTP code and stores in DB
  ↓ returns previewCode directly (no email required)
  ↓ optionally attempts to send email (non-blocking)
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

### Production Login Requirements

**In production, only authorized emails can log in:**

1. **Authorized emails** are:
   - Emails that match a profile in the database (stored in `profile_sections` with `section_key='basic_information'` and `email` field)
   - Admin emails (configured in `ADMIN_EMAIL` or `ADMIN_EMAILS` environment variables)

2. **Unauthorized emails** will receive a 403 error with message "Access denied. This email is not authorized for login."

3. **To authorize a new email for production login:**
   - Create a profile in the database with a `profile_sections` entry that includes the email in the `basic_information` section
   - OR add the email to `ADMIN_EMAIL` or `ADMIN_EMAILS` environment variable

### Email OTP not sending emails?

**Email delivery is optional** - users can log in with the `previewCode` returned in the response.

If you want to enable email notifications:

1. **Set Railway environment variables**:
   - `RESEND_API_KEY` - Your Resend API key
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
   - In production, should return `previewCode` for authorized emails

## Security Notes

- In production, only authorized emails (matching profiles or admin emails) can initiate login
- OTP codes are returned directly via `previewCode` for authorized users
- Email delivery is optional and non-blocking
- Email logic runs server-side on Railway (not client-side on Vercel)
- Same-origin proxy prevents CORS attacks
- JWT tokens are signed with `AUTH_JWT_SECRET` on Railway backend
