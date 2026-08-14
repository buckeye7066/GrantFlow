# GrantFlow Production Readiness (Reality Report)

**Investigation snapshot:** 2026-01-15 (see staleness note below — this page was not kept current).

**Staleness note (added 2026-08-14, gf-phase2-batch-02 purpose-alignment pass):** the "Known
Production Issues" section below documents a specific incident investigated on 2026-01-15 and
was written in the present tense ("live") even though it was never updated after that date —
this file WAS touched as recently as 2026-08-06 (env-example filename fix) without anyone
correcting the stale incident content. Treat it as a historical snapshot, not current status.
**[`ERROR_LEDGER.md`](ERROR_LEDGER.md)** is the actively-maintained incident tracker and is the
authoritative source for whether E-001/E-002 are still open. A live spot-check run today
(2026-08-14) confirmed `https://app.axiombiolabs.org/grantflow/api/health` currently returns
`200` with a healthy JSON body (23,848 opportunities tracked, Postgres/Railway, "System is
operating normally") — so at minimum the `app.axiombiolabs.org` path described as working below
is still working. The `www.axiombiolabs.org` 404 claim below was **not** independently
re-verified in this pass (an automated fetch of that host returned an ambiguous bundled-SPA
response, not a clean signal either way) — do not treat it as confirmed fixed or still broken
without checking `ERROR_LEDGER.md` or re-probing directly.

This is the production-readiness "reality report" for GrantFlow: what's deployed, what's broken, and what we verify before shipping changes.

## Current Deployment Topology (observed)

- **Frontend SPA**: Vite build hosted on **Vercel**, intended to be served from **`/grantflow`**
- **Backend API**: Node/Express hosted on **Railway**

## Known Production Issues (as investigated 2026-01-15 — current status is in ERROR_LEDGER.md)

See **[`ERROR_LEDGER.md`](ERROR_LEDGER.md)** for current status.

### Key finding (2026-01-15, historical)

- `app.axiombiolabs.org/grantflow/*` works (login + API health).
- `www.axiombiolabs.org/grantflow/login` returns a static "File not found (404 error)" page.
- `www.axiombiolabs.org/grantflow/api/health` also 404s.

This strongly suggested a **domain routing / rewrites** problem for `www.axiombiolabs.org` (not an SPA/router code bug) as of the investigation date above.

## Baseline Quality Gate (local)

Use the built-in baseline gate:

```bash
npm run doctor
```

This runs: env inventory → lint → typecheck → unit → build → start backend → Playwright smoke.

## Environment Variables (single source of truth)

- **[`ENVIRONMENT.md`](ENVIRONMENT.md)**: Production env variable requirements + verification notes
- **`.env.example`** / **`backend/.env.example`**: generated, checked environment templates

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

To fully complete the live “Error Ledger” phase we need:

- Vercel logs (prod) for `www.axiombiolabs.org` requests and rewrite behavior
- Railway logs for `/api/*` around the same times
