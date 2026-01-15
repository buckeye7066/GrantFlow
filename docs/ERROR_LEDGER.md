# GrantFlow Error Ledger

This ledger captures **production failures** (user-visible or log-visible) with **stable signatures**, hypotheses, and the next action to verify/fix.

## Active Incidents / High Priority

| ID | When (UTC) | Surface | Symptom | Signature | Hypothesis | Status | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-001 | 2026-01-15 | `www.axiombiolabs.org` | Deep links under `/grantflow/*` return a static "File not found (404 error)" page (example: `/grantflow/login`). `/grantflow/api/health` also 404s. | GoDaddy-style "File not found (404 error)" for `/grantflow/*` subpaths on `axiombiolabs.org`, while `app.axiombiolabs.org/grantflow/*` works. | `www.axiombiolabs.org` is not being served by the Vercel SPA project (or missing rewrites), so only the root `/grantflow` entrypoint happens to resolve while subpaths and `/api` do not. | Open | Verify DNS + hosting: confirm `www.axiombiolabs.org` is mapped to the same Vercel project as `app.axiombiolabs.org`, and that Vercel rewrites include `/grantflow/:path* -> /index.html` and `/grantflow/api/:path* -> Railway`. |

## Evidence (screenshots)

Screenshots captured during investigation:

- `health-app-grantflow.png`: `app.axiombiolabs.org/grantflow/api/health` returns JSON `{ status: "healthy", dialect: "postgres", ... }`
- `health-www-grantflow-404.png`: `axiombiolabs.org/grantflow/api/health` returns a static 404 page
- `www-grantflow-login-404.png`: `axiombiolabs.org/grantflow/login` returns a static 404 page

## Notes / Access Needed

- Vercel logs (production) for the `www.axiombiolabs.org` domain + rewrites config.
- Railway logs around the same timestamps (to confirm whether requests ever reached the backend).
- Base44 export verification failures (if any) to correlate missing config vs missing code.