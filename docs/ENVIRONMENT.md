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

- **Free/local AI failover (OpenAI-compatible)**
  - Used after OpenAI and Anthropic are missing, out of credit/quota, rate-limited, timed out, or return an unusable response. GrantFlow tries configured routes in order and reports the actual provider as `free:<route-id>`; it never turns a provider failure into fabricated output.
  - **Ollama/local shorthand:** set `OLLAMA_BASE_URL` to the server's OpenAI-compatible `/v1` URL and `OLLAMA_MODEL` to an installed model. `OLLAMA_API_KEY` is optional for gateways that require one.
  - **Generic shorthand:** set `FREE_AI_BASE_URL`, `FREE_AI_MODEL`, and optionally `FREE_AI_API_KEY`.
  - **Multiple routes:** set `FREE_AI_ROUTES` to a JSON array such as:
    ```json
    [
      { "id": "local-primary", "base_url": "http://ollama:11434/v1", "model": "your-installed-model" },
      { "id": "free-tier-backup", "base_url": "https://provider.example/v1", "model": "provider-model", "api_key_env": "FREE_TIER_PROVIDER_KEY" }
    ]
    ```
    Put only the secret's environment-variable **name** in `api_key_env`; set its value separately in Railway. Do not embed credentials in URLs or in `FREE_AI_ROUTES`.
  - **`FREE_AI_TIMEOUT_MS`** — per-client timeout in milliseconds (default `12000`).
  - **`FREE_AI_MAX_RETRIES`** — SDK retries per free route (default `0`; GrantFlow already advances to the next route).
  - **`FREE_AI_RESERVE_MS`** — part of the shared request deadline reserved for free-route failover (default `6000`).
  - Free/local chat fallback is read-only unless a provider completed a registered GrantFlow tool call. It cannot claim that Anya saved, submitted, deleted, or changed profile data.

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
  - **`HAMILTON_TAILORED_APPROVAL_GATE`** - defaults ON. Set to `"0"` to disable the per-funder tailored-application auto-submit gate (operational escape hatch only). When ON, Hamilton may auto-submit a portal card ONLY when its tailored narrative is approved/edited, has no outstanding missing questions, and the profile's `hamilton_auto_submit` toggle is on.
  - **`HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST`** - Optional comma-separated host allowlist (e.g. `tn.gov,mtsu.edu`). Empty = no restriction.
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

- **Hamilton weekly per-profile digest (Monday, America/New_York — DST-aware)**
  - One "where your funding stands" update per ACTIVE profile (status not
    `deleted`/`suspended`, excluding Amy's synthetic `agent:amy` profiles)
    every Monday. Persisted-checkpoint scheduler (`system_kv` week marker +
    scheduler lock + hourly catch-up) — a Railway redeploy can neither skip a
    week nor double-send.
  - **`HAMILTON_WEEKLY_DIGEST_ENABLED`** - `"true"` (DEFAULT). `"false"` disables.
  - **`HAMILTON_WEEKLY_DIGEST_HOUR_ET`** - Trigger hour, ET. Default `8`. Prod runs `9` (owner spec: Monday 09:00 ET).
  - **`HAMILTON_WEEKLY_DIGEST_DELIVERY`** - `"draft"` (DEFAULT) drafts one Outlook
    message per profile into the owner's mailbox for manual review/send.
    `"send"` (owner-approved 2026-07-02; set in prod) AUTO-SENDS each profile's
    digest to its contact emails via the comms channel (Resend); every send is
    recorded in `comms_broadcasts` / `comms_broadcast_recipients` with kind
    `weekly_digest` for the Sam/Anya observability trail. The leads pipeline
    (John) is unaffected and stays draft-only.

- **Billing automation (invoices + reminders + suspension)**
  - Gated by **`BILLING_AUTOMATION_ENABLED`** - `"true"` in prod. Hourly
    idempotent cycle (`runBillingCycle`): one invoice per (profile, period_key),
    dunning second notice after `BILLING_SECOND_NOTICE_DAYS` (default 3),
    suspension after a full billing cycle (or `BILLING_SUSPEND_DAYS` override)
    and only when a payment path exists (Stripe configured or
    `BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE=true`).
  - Cadence is per account (`billing_accounts.billing_cadence`, user-settable
    via `PUT /api/billing/me/:profileId/cadence` and the Billing page):
    `weekly` (every Friday 09:00 ET), `biweekly` (every OTHER Friday 09:00 ET —
    parity anchored to the account's persisted `billing_anchor_at`, falling
    back to the fixed epoch Friday `2026-01-02`, so redeploys can never flip
    the alternation), `semimonthly` (1st + 16th), `monthly` (FIRST FRIDAY of
    the month, 09:00 ET).

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
- `SENTRY_DSN` (Railway/backend error capture)
- `SENTRY_ENVIRONMENT` (Railway/backend environment label)
- `SENTRY_RELEASE` (Railway/backend release identifier; defaults to Railway/Vercel commit metadata when present)
- `SENTRY_TRACES_SAMPLE_RATE` (Railway/backend tracing sample rate; default `0`)
- `VITE_SENTRY_DSN` (Vercel/frontend browser error capture)
- `VITE_SENTRY_ENVIRONMENT` (Vercel/frontend environment label)
- `VITE_SENTRY_RELEASE` (Vercel/frontend release identifier)
- `VITE_SENTRY_TRACES_SAMPLE_RATE` (Vercel/frontend tracing sample rate; default `0`)

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
