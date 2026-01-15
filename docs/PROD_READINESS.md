# GrantFlow Production Readiness (“Reality Report”)

This document is the **source of truth** for how GrantFlow is deployed, what is currently broken, and exactly how we verify it in production.

## Architecture (current)

```
Browser
  └─ https://app.axiombiolabs.org/grantflow  (Vercel SPA, Vite + React Router)
        ├─ /grantflow/*                 → SPA fallback (serves dist/index.html)
        ├─ /api/*                       → rewrite → Railway API (Express)
        └─ /grantflow/api/*             → rewrite → Railway API (Express)

Railway (Express API)
  ├─ https://grantflow-production.up.railway.app/api/*
  ├─ DB_PROVIDER=postgres → Postgres (Railway service)
  └─ DB_PROVIDER=sqlite   → SQLite (file path via SQLITE_DB_PATH)
```

## Critical domain truth (as observed)

### What works today
- **`app.axiombiolabs.org`** is correctly routed to Vercel and serves the SPA and `/api/*` rewrites.

### What is broken today (root cause of the customer-facing 404)
- **`axiombiolabs.org/grantflow/*`** returns **GoDaddy 404** (served by GoDaddy “DPS”).
- GoDaddy DNS currently has **`CNAME www → axiombiolabs.org`**, which points users at the GoDaddy-hosted apex site instead of Vercel.

### Required DNS target state (to make `www.axiombiolabs.org/grantflow` work)
- In GoDaddy DNS:
  - **Replace** `CNAME www` value with **`cname.vercel-dns.com`** (Vercel)
  - Keep `CNAME app` as-is (already points at Vercel)

## Runtime entrypoints inventory

### Frontend
- **Framework**: React (Vite)
- **Router**: `react-router-dom` `BrowserRouter` with `basename` derived from `VITE_APP_BASE`
- **Base path**: `/grantflow` (production)

### Backend
- **Framework**: Express (`backend/server.js`)
- **API base**: `/api/*`
- **Health**: `GET /api/health` (public), `GET /api/admin/diagnostics` (admin)
- **Build metadata**: `GET /api/meta/build` (public)

### Crawlers / job runner
- **Job table**: `crawler_jobs` (queued/running/completed/failed)
- **Schedules table**: `crawler_schedules` (cron strings per profile + crawler_type)
- **Dispatch**: `dispatchCrawlerJob()` runs jobs asynchronously after creation
- **National continuous crawler**: gated by `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

### Anya
- **API**: `/api/anya/*`
- **Admin diagnostics tool**: `admin.diagnostics` (via tool registry)

## Environment variables (authoritative list)

### Vercel (Frontend)
| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `VITE_APP_BASE` | yes | `/grantflow` | Router base path |
| `VITE_API_URL` | no | *(unset in prod)* | If unset, frontend uses relative `/api/*` which Vercel rewrites to Railway |
| `VITE_CANONICAL_HOST` | optional | `www.axiombiolabs.org` | Canonical host (only enforced if strict enabled) |
| `VITE_CANONICAL_HOST_STRICT` | optional | `true` | Enforce redirects to canonical host |

### Railway (Backend)
| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `PORT` | yes | `8080` | Server port |
| `NODE_ENV` | yes | `production` | Runtime mode |
| `DB_PROVIDER` | yes | `postgres` | DB selection (`postgres` or `sqlite`) |
| `DATABASE_URL` | if `postgres` | *(Railway injected)* | Postgres connection |
| `SQLITE_DB_PATH` | if `sqlite` | `/data/grantflow.db` | SQLite file path |
| `AUTH_JWT_SECRET` | **yes in prod** | *(random)* | JWT signing |
| `RESEND_API_KEY` | **yes in prod** | `re_...` | Email OTP delivery |
| `FROM_EMAIL` | **yes in prod** | `noreply@axiombiolabs.org` | Sender |
| `OPENAI_API_KEY` | required for AI features | `sk-...` | AI features (Anya + enrichment + avatar lookup) |
| `OPENAI_TIMEOUT_MS` | recommended | `20000` | OpenAI request timeout |
| `OPENAI_MAX_RETRIES` | recommended | `2` | OpenAI client retry count |

## Verification plan (10–15 minutes)

### 1) Frontend routing (deep links)
- `GET https://app.axiombiolabs.org/grantflow/login` → **200**, loads login UI
- `GET https://app.axiombiolabs.org/grantflow` → **200**, loads dashboard shell

### 2) Backend availability
- `GET https://app.axiombiolabs.org/api/health` → **200**, JSON with `status`
- `GET https://grantflow-production.up.railway.app/api/health` → **200**
- `GET https://app.axiombiolabs.org/api/meta/build` → JSON with `sha`

### 3) Auth (email OTP)
- Request a code
- Confirm the verification endpoint returns 200 and establishes session
- Confirm no 5xx in Railway logs during the flow

### 4) Crawlers (on-demand)
- Trigger a crawl via the UI (or admin tools)
- Confirm `crawler_jobs` has a row and transitions queued → running → completed

### 5) Anya
- Open Anya UI
- Confirm a simple prompt returns a response (and if OpenAI is down, UI shows a graceful failure, not a blank screen)

## Error Ledger (baseline evidence)

| ID | Symptom | Where observed | Evidence | Root cause | Fix |
| --- | --- | --- | --- | --- | --- |
| EL-001 | `axiombiolabs.org/grantflow/login` shows “File not found (404)” | Live site | GoDaddy DPS 404 page | Apex domain is served by GoDaddy hosting; no SPA rewrite | DNS/hosting: route `www` to Vercel (see “Critical domain truth”) |
| EL-002 | `www.axiombiolabs.org/grantflow/*` does not serve SPA | Live site | GoDaddy DNS shows `CNAME www → axiombiolabs.org` | `www` is pointing at apex instead of Vercel | Change `CNAME www → cname.vercel-dns.com` |
| EL-003 | Railway shows container stop / `SIGTERM` | Railway logs | Log Explorer entries show stop + npm SIGTERM | Platform restart/deploy/healthcheck cycling; requires log signature + settings verification | Investigate Railway service settings + healthcheck behavior; ensure stable boot and no crash loops |
| EL-004 | `app.axiombiolabs.org/api/meta/build` returns 200 but `www` does not | Live site | `app` serves JSON with git sha; `www` 301→apex 404 | `www` DNS points to apex instead of Vercel | Change `CNAME www → cname.vercel-dns.com` |

## Known failure modes + self-recovery
- **Missing `RESEND_API_KEY`**: email OTP delivery becomes unreliable; must be treated as production misconfiguration and flagged in health/diagnostics.
- **OpenAI outages**: Anya and AI enrichment must degrade gracefully; core app flows must remain available.

