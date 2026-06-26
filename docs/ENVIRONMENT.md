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

### Free Week promotion (give the app away, time-boxed)

A global switch that unlocks every premium capability for **all** users and
bills **$0** while active. Self-expires — no scheduler, no cleanup. Flip these
in the Railway dashboard to start/stop the promotion with no deploy. Source of
truth: `shared/freeWeek.js` (enforced in `backend/utils/tierGating.js` and
`backend/services/billingAccounts.js`; status surfaced at `GET /api/billing/catalog`).

- **`FREE_WEEK_ENABLED`** — set to `true` to arm the promotion (default off).
- **`FREE_WEEK_START`** — ISO date/time the window opens (optional; if omitted, opens as soon as enabled).
- **`FREE_WEEK_END`** — ISO date/time the window closes (optional; defaults to 7 days after start).
- **`FREE_WEEK_LABEL`** — optional banner text shown to users while active.
- **`FREE_WEEK_SIGNUP_PERIOD`** — `week` (default) | `month` | `none`. While the window is open, anyone who signs up gets their OWN full free period from their signup date (self-expiring via `billing_accounts.free_until`), so a last-day joiner still gets a complete trial after the shared window closes. `none` keeps the shared window but skips per-signup grants.

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

- **Hamilton browser automation**
  - **`HAMILTON_ENABLE_BROWSER_AUTOMATION`** - `"true"` to let Hamilton drive a real Playwright browser; otherwise she degrades to the lawful pdf/docx packet.
  - **`HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST`** - Optional comma-separated host allowlist (e.g. `tn.gov,mtsu.edu`). Empty = no restriction.
  - **`HAMILTON_ALLOW_AUTOSUBMIT`** - `"true"` to let Hamilton submit portal applications (per-source authorization still gates it).
  - **`HAMILTON_BROWSER_STORAGE_DIR`** - Optional on-disk dir for legacy storageState files (path-traversal guard root). Sessions are stored encrypted in Postgres regardless; Railway disk is ephemeral.

- **Hamilton cloud interactive login (Option B — in-app portal session capture)**
  - Lets a user log into a portal once (clearing 2FA themselves) so Hamilton can reuse the resulting AES-256-GCM-encrypted, profile-bound, revocable session. **ON globally by default** — no env required.
  - **`HAMILTON_CLOUD_LOGIN_PROVIDER`** - `self_hosted` (DEFAULT), `cdp`, or `disabled`.
    - `self_hosted` - Launches GrantFlow's own Playwright Chromium (the one already shipped for browser automation) and serves the interactive surface from Chromium's built-in DevTools inspector. No third-party service, no paid key.
    - `cdp` - Use a hosted interactive Chrome (Browserless/Browserbase) for a polished streamed live URL. Requires `HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT`.
    - `disabled` - Turn the feature off; the UI falls back to Saved Login.
  - **`HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT`** - CDP/WebSocket endpoint of a hosted interactive Chrome. Setting this auto-selects the `cdp` provider unless `HAMILTON_CLOUD_LOGIN_PROVIDER` says otherwise.
  - **`HAMILTON_CLOUD_LOGIN_PUBLIC_BASE`** - For `self_hosted` on a single-port PaaS (e.g. Railway): a public base URL that reverse-proxies Chromium's devtools endpoint so a remote device (phone) can reach the interactive window. If unset on such a host, the interactive window may not be reachable remotely (session capture still works for local/self-hosted hosts and via the CLI tool); the UI surfaces this and points users to Saved Login.
  - **`HAMILTON_CLOUD_LOGIN_ENABLED`** - Back-compat kill switch: `"false"` disables cloud login regardless of provider.

- **Verification layer (ProPublica + US Census — FREE, NO API KEY)**
  - A best-effort, non-blocking enrichment layer that confirms tax-exempt orgs
    (IRS Form 990 via ProPublica Nonprofit Explorer) and resolves a profile's /
    opportunity's location to county + FIPS (US Census Geocoder). Both APIs are
    public and keyless — only enablement and timeouts are configurable. Every
    call degrades gracefully on error/timeout/rate-limit and NEVER blocks
    discovery or hard-rejects an opportunity. See
    `backend/services/verification/`.
  - **`ENABLE_REGISTRY_VERIFICATION`** - `"true"` (DEFAULT) to confirm
    organization sponsors against the IRS tax-exempt registry. `"false"` fully
    disables the network path. **BOOST-ONLY:** a *verified* tax-exempt sponsor
    nudges confidence up; a registry MISS or API-down is STRICTLY NEUTRAL —
    never down-weighted, never rejected, never flagged. (ProPublica only holds
    IRS Form 990 FILERS; churches/faith-based orgs, brand-new nonprofits,
    government entities, and non-501(c)(3) orgs are legitimately absent, so a
    miss is NOT evidence an org is fake.)
  - **`ENABLE_CENSUS_GEO`** - `"true"` (DEFAULT) to deterministically resolve
    ZIP/address → county + FIPS for sharper geo matching (reduces out-of-state
    false positives). `"false"` disables the network path; the matcher falls
    back to its existing state logic unchanged.
  - **`REGISTRY_VERIFICATION_TIMEOUT_MS`** - Per-request ProPublica timeout (ms). Default `4000`.
  - **`CENSUS_GEO_TIMEOUT_MS`** - Per-request Census timeout (ms). Default `4000`.
  - **`VERIFICATION_CACHE_TTL_MS`** - In-memory cache TTL for verification lookups (ms). Default `86400000` (24h).
  - **`VERIFICATION_CACHE_MAX_ENTRIES`** - LRU cap on the in-memory cache. Default `5000`.

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

