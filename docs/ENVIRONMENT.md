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

- **`VITE_CANONICAL_HOST`** (prod)
  - Example: `www.axiombiolabs.org`
  - Canonical host to enforce (only if strict mode is enabled).

- **`VITE_CANONICAL_HOST_STRICT`** (prod)
  - Example: `true`
  - When `true`, the frontend redirects to `VITE_CANONICAL_HOST` if accessed via another host.

- **`VITE_API_PROXY_TARGET`** (dev-only)
  - Example: `http://localhost:8080`
  - Used by Vite dev server to proxy `/api/*` calls to the backend.

- **`VITE_ASSET_BASE`**
  - Example: `/`
  - Controls Vite `base` for assets in the built bundle.

---

## Backend (Railway)

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

- **`CORS_ORIGIN`**
  - Example: `https://app.axiombiolabs.org,https://www.axiombiolabs.org`
  - Comma-separated list of allowed origins.

### Admin (Required for admin access)

- **`ADMIN_TOKEN`** (or `ANYA_ADMIN_TOKEN`)
  - Required to access admin-only endpoints/tools.

- **`ADMIN_EMAIL`**
  - Used for admin notifications and admin identification defaults.

### Optional integrations (feature-gated — do NOT block boot)

- **OpenAI**
  - **`OPENAI_API_KEY`**
  - Used by AI routes and some enrichment features. Core flows (login, profiles, pipeline) must still work without it.
  - Recommended: **`OPENAI_TIMEOUT_MS`** (default `20000`) and **`OPENAI_MAX_RETRIES`** (default `2`).

- **Anthropic (Anya)**
  - **`ANTHROPIC_API_KEY`**
  - Used by Anya status/tools. Core flows must still work without it.

- **Email (Resend)**
  - **`RESEND_API_KEY`**
  - **`FROM_EMAIL`**

### Optional crawlers / scheduling

- **`CRAWLER_SCHEDULER_ENABLED`**
  - Example: `true`
  - When enabled, the backend periodically checks `crawler_schedules` and enqueues due jobs into `crawler_jobs` with a unique `idempotency_key`.

- **`CRAWLER_SCHEDULER_INTERVAL_MS`**
  - Example: `60000`
  - Scheduler polling interval (milliseconds).

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

