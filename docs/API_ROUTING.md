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
- Password setup + password login runs on Railway (`/api/auth/password/*`)
- In production, only emails matching existing profiles can start login (profile-email gated access)
- Admins can always log in (emails in `ADMIN_EMAIL` or `ADMIN_EMAILS`)
- Environment variables for email (`RESEND_API_KEY`, `FROM_EMAIL`) **must be set in Railway** if you want email notifications
- Setting these in Vercel does nothing, because Vercel only serves static assets

### Request Flow for Email OTP Login

```
Browser (frontend)
  ↓ POST /api/auth/password/setup/start
  ↓
Vercel (sees request to /api/*)
  ↓ (rewrites via vercel.json)
  ↓
Railway Backend (backend/routes/auth.js)
  ↓ checks if email matches existing profile (production only)
  ↓ if first login: generates one-time password setup token and emails link (non-blocking)
  ↓ otherwise: client prompts for password login
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
   - The response includes `redirect_to: "/ServiceApplication"`, and the frontend should redirect the user to the Service Application flow.

3. **To authorize a new email for production login:**
   - Create a profile in the database with a `profile_sections` entry that includes the email in the `basic_information` section
   - OR add the email to `ADMIN_EMAIL` or `ADMIN_EMAILS` environment variable

### Password setup email not arriving?

**CRITICAL: Email service MUST be configured in production environments (Railway).**

If email is not configured properly, users will see an error message instead of being told to check their email. This is intentional - production environments require working email delivery.

#### Required Railway Environment Variables

Set these in Railway project settings → Variables:

1. **`RESEND_API_KEY`** (REQUIRED)
   - Your Resend API key from https://resend.com
   - Format: `re_xxxxxxxxxxxxx`
   - Get it from: Resend Dashboard → API Keys

2. **`FROM_EMAIL` or `EMAIL_FROM`** (REQUIRED)
   - Must be a verified domain in Resend
   - Format: `noreply@yourdomain.com` or `GrantFlow <noreply@yourdomain.com>`
   - DO NOT use `onboarding@resend.dev` - this is only for examples
   - Domain must be verified in Resend Dashboard → Domains

3. **`AUTH_JWT_SECRET`** (REQUIRED)
   - Secret key for signing authentication tokens
   - Format: Any secure random string (minimum 32 characters recommended)
   - Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. **`NODE_ENV`** (REQUIRED for production)
   - Set to `production` in Railway production environment
   - This enables production security checks

#### How to Verify Railway Environment Variables

1. Go to Railway dashboard: https://railway.app
2. Select your project (GrantFlow)
3. Click on your backend service
4. Go to "Variables" tab
5. Verify these variables are present with correct values:
   - ✅ `RESEND_API_KEY` - Should start with `re_`
   - ✅ `FROM_EMAIL` or `EMAIL_FROM` - Should be a real email address
   - ✅ `AUTH_JWT_SECRET` - Should be a long random string
   - ✅ `NODE_ENV` - Should be `production`

#### Troubleshooting Email Delivery

**Check Railway logs** for email sending errors:

```bash
# Look for these log messages in Railway logs:
[email/sendVerificationEmail] Email service not configured
[email/sendPasswordSetupEmail] Email service not configured
[email/sendVerificationEmail] Resend API error
[auth/email/start] Error sending email
[auth/password/setup/start] Error sending email
```

Log messages will include:
- `provider: resend` - Confirms using Resend service
- `runtime: railway` - Confirms running on Railway
- `has_api_key: false` - Indicates RESEND_API_KEY is missing
- `has_from_email: false` - Indicates FROM_EMAIL is missing or invalid

**Verify Resend dashboard** at https://resend.com:
1. Domain is verified (green checkmark)
2. API key is active and valid
3. FROM_EMAIL matches a verified domain
4. Check "Logs" tab for delivery status and errors

**Test in development first:**
- Run backend locally with `.env` file containing the same Railway variables
- Attempt login to verify email sends successfully
- Check console logs for any errors

**Common Issues:**

1. **"Email service not configured"** error:
   - Missing RESEND_API_KEY or FROM_EMAIL in Railway
   - Solution: Add both variables in Railway → Variables

2. **"Invalid FROM_EMAIL configuration"** error:
   - FROM_EMAIL contains `onboarding@resend.dev` (example address)
   - FROM_EMAIL contains `FROM_EMAIL=` (pasted KEY=VALUE format)
   - FROM_EMAIL domain is not verified in Resend
   - Solution: Use a verified domain email address

3. **Email sent but not received:**
   - Check Resend dashboard → Logs for delivery status
   - Verify recipient email is correct
   - Check spam/junk folder
   - Domain SPF/DKIM records may need configuration

4. **Users see "Check your email" but email fails:**
   - This should NOT happen anymore after this fix
   - In production, users will see "Email service unavailable" if email is not configured
   - In development, users see a preview token/link in the response

### How to verify routing is correct?

1. Open browser dev tools → Network tab
2. Login with email OTP
3. Check the request to `/api/auth/email/start`
   - Should be same-origin (no CORS preflight)
   - Response should come from Railway (check response headers)
   - In production, unauthorized emails return 403 + `redirect_to` for client-side redirect

## Security Notes

- In production, only authorized emails (matching profiles or admin emails) can initiate login
- Password setup uses a one-time emailed link; codes are not returned in production responses
- Email delivery is optional and non-blocking
- Email logic runs server-side on Railway (not client-side on Vercel)
- Same-origin proxy prevents CORS attacks
- JWT tokens are signed with `AUTH_JWT_SECRET` on Railway backend
