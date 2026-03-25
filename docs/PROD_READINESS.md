# GrantFlow Production Readiness (Reality Report)

**Last updated:** 2026-01-15

This is the production-readiness â€œreality reportâ€ for GrantFlow: whatâ€™s deployed, whatâ€™s broken, and what we verify before shipping changes.

## Current Deployment Topology (observed)

- **Frontend SPA**: Vite build hosted on **Vercel**, intended to be served from **`/grantflow`**
- **Backend API**: Node/Express hosted on **Railway**

## Known Production Issues (live)

See **[`ERROR_LEDGER.md`](ERROR_LEDGER.md)**.

### Key finding (2026-01-15)

- `app.axiombiolabs.org/grantflow/*` works (login + API health).
- `www.axiombiolabs.org/grantflow/login` returns a static â€œFile not found (404 error)â€ page.
- `www.axiombiolabs.org/grantflow/api/health` also 404s.

This strongly suggests a **domain routing / rewrites** problem for `www.axiombiolabs.org` (not an SPA/router code bug).

## Baseline Quality Gate (local)

Use the built-in baseline gate:

```bash
npm run doctor
```

This runs: env inventory â†’ lint â†’ typecheck â†’ unit â†’ build â†’ start backend â†’ Playwright smoke.

## Environment Variables (single source of truth)

- **[`ENVIRONMENT.md`](ENVIRONMENT.md)**: Production env variable requirements + verification notes
- **`env.example`** / **`backend/env.example`**: Example env files

## Deployment Playbooks

- **[`VERCEL_RAILWAY_DEPLOYMENT.md`](VERCEL_RAILWAY_DEPLOYMENT.md)**: Step-by-step deploy
- **[`RELEASE_RUNBOOK.md`](RELEASE_RUNBOOK.md)**: Release flow + rollback
- **[`DEPLOYMENT.md`](DEPLOYMENT.md)**: Short index

## Verification Checklist (minimum)

- **Routing**
  - `/<base>/` loads (no blank screen)
  - `/<base>/login` loads (deep refresh works)
  - `/<base>/api/health` returns `200`
- **Auth**
  - Email OTP start + verify works
  - Session refresh works (no infinite loop / hard refresh required)
- **Admin**
  - Admin can access admin UI and see expected data tabs
- **Crawlers**
  - Admin can queue a job and see run history / status

## What still needs log access to complete Phase 0.4

To fully complete the live â€œError Ledgerâ€ phase we need:

- Vercel logs (prod) for `www.axiombiolabs.org` requests and rewrite behavior
- Railway logs for `/api/*` around the same times