## GrantFlow Environment Variables (Vercel + Railway)

This document is the **single source of truth** for environment variables required to run GrantFlow in production.

### Conventions

- **Frontend (Vercel)** uses Vite env vars prefixed with `VITE_`.
- **Backend (Railway)** uses standard Node env vars.
- **Required** means: the app cannot function correctly without it (either at boot or when that feature is invoked).
- **Optional** means: the app boots and core flows work, but a feature is disabled until configured.

---

## Frontend (Vercel)

### Required

- **`VITE_APP_BASE`**
  - Example: `/grantflow`
  - Used as the router basename and for redirects.

### Optional

- **`VITE_API_URL`**
  - Example (local dev): `http://localhost:8080`
  - Used **only in development** to hit a remote backend directly.
  - In production, the frontend should use same-origin `/api` (via rewrites/proxy) and typically does **not** need this.

- **`VITE_API_PROXY_TARGET`** (dev-only)
  - Example: `http://localhost:8080`
  - Used by Vite dev server to proxy `/api/*` calls to the backend.

- **`VITE_ASSET_BASE`**
  - Example: `/`
  - Controls Vite `base` for assets in the built bundle.

---

## Backend (Railway)

**IMPORTANT: All backend environment variables must be set in Railway, NOT Vercel.**

The architecture works as follows:
- **Frontend** is deployed on Vercel and serves static assets (HTML, JS, CSS)
- **Backend** API runs on Railway (Express server on Node.js)
- `vercel.json` rewrites all `/api/*` requests to Railway backend URL
- **Auth and email logic runs on Railway**, not Vercel
- Email delivery uses **Resend** and must be configured in Railway environment

### Required (always)

- **`NODE_ENV`**
  - Example: `production`

- **`PORT`**
  - Example: `8080`

### Database (Required for chosen provider)

- **`DB_PROVIDER`**
  - Values: `sqlite` (default) | `postgres`

#### Postgres mode (required)

- **`DATABASE_URL`**
  - Must be a `postgres://` connection string.
  - **Fail-fast**: if `DB_PROVIDER=postgres` and `DATABASE_URL` is missing/invalid, the backend will refuse to start.

#### SQLite mode (required)

- **`SQLITE_DB_PATH`**
  - Example: `backend/data/grantflow.db`
  - Only used when `DB_PROVIDER=sqlite`.

### Auth (Required for real production usage)

- **`AUTH_JWT_SECRET`** (or `JWT_SECRET`)
  - Example: `super-long-random-string`
  - Required for secure session signing.
  - **Set in Railway only**

- **`CORS_ORIGIN`**
  - Example: `https://app.axiombiolabs.org,https://www.axiombiolabs.org`
  - Comma-separated list of allowed origins.
  - **Set in Railway only**

### Admin (Required for admin access)

- **`ADMIN_TOKEN`** (or `ANYA_ADMIN_TOKEN`)
  - Required to access admin-only endpoints/tools.
  - **Set in Railway only**

- **`ADMIN_EMAIL`**
  - Used for admin notifications and admin identification defaults.
  - **Set in Railway only**

### Optional integrations (feature-gated — do NOT block boot)

- **OpenAI**
  - **`OPENAI_API_KEY`**
  - Used by AI routes and some enrichment features. Core flows (login, profiles, pipeline) must still work without it.

- **Anthropic (Anya)**
  - **`ANTHROPIC_API_KEY`**
  - Used by Anya status/tools. Core flows must still work without it.

- **Email (Resend)** - Required for email-based OTP login
  - **`RESEND_API_KEY`** - API key from resend.com dashboard
    - **MUST be set in Railway** (backend runtime, not Vercel)
  - **`FROM_EMAIL`** (or `EMAIL_FROM`) - Verified sender email address
    - Example: `noreply@yourdomain.com`
    - Domain must be verified in Resend dashboard
    - **MUST be set in Railway** (backend runtime, not Vercel)
    - Do NOT use `@resend.dev` test addresses in production
  - **`AUTH_ALLOW_ADMIN_PREVIEW_CODE`** - Optional failsafe for admin lockout
    - Set to `"true"` to enable preview codes for admin users when email fails
    - Only affects admin users (as defined in `ADMIN_EMAIL`/`ADMIN_EMAILS`)
    - Does NOT weaken security for non-admin users
    - Useful for production troubleshooting but should be disabled normally

- **SMS (Twilio)**
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`)

### Optional observability

- `LOG_LEVEL`
- `SENTRY_DSN`

---

## Verification Checklist (quick)

- Frontend loads at `/<VITE_APP_BASE>/` and can reach `/api/health`.
- Backend `/api/health` returns `200` and includes `"dialect":"postgres"` when in Postgres mode.
- Login works (email OTP start + verify).
- Dashboard loads without blank screen.

---

## Rollback Notes

- To rollback DB provider:
  - set `DB_PROVIDER=sqlite` and `SQLITE_DB_PATH=...`
  - redeploy Railway service

