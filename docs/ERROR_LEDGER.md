# GrantFlow Error Ledger

This ledger captures **production failures** (user-visible or log-visible) with **stable signatures**, hypotheses, and the next action to verify/fix.

## Active Incidents / High Priority

| ID | When (UTC) | Surface | Symptom | Signature | Hypothesis | Status | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-001 | 2026-01-15 | `axiombiolabs.org` / `www.axiombiolabs.org` | `www` redirects to apex. Apex serves `/grantflow/` but **deep links** (`/grantflow/login`) and `/grantflow/api/*` return 404 HTML (not the SPA / API). | `www.axiombiolabs.org/grantflow/login` → `301 Location: https://axiombiolabs.org/grantflow/login`; `axiombiolabs.org/grantflow/login` → `404` HTML; `axiombiolabs.org/grantflow/api/health` → `404` HTML. `Server: DPS/2.0.0-beta+sha-42b7380` on apex responses. | Apex/`www` are not routed to the Vercel SPA project + API proxy (likely still on GoDaddy/DPS). Only a static `/grantflow/` page is being served at apex, with **no SPA fallback rewrite** and **no API proxy**. | Open | Fix DNS/hosting so apex/`www` map to the same Vercel project that serves the SPA. If apex must remain on DPS, it needs SPA fallback rewrites for `/grantflow/*` and a reverse proxy for `/grantflow/api/*` → Railway. |
| E-002 | 2026-01-16 | `app.axiombiolabs.org` | `/grantflow/` (trailing slash) returns Vercel `NOT_FOUND`, while `/grantflow/login` works and `/grantflow/api/health` works. | `GET https://app.axiombiolabs.org/grantflow/` → `404` `text/plain` `"The page could not be found NOT_FOUND ..."`, `Server: Vercel`. `GET /grantflow/login` → `200` HTML. `GET /grantflow/api/health` → `200` JSON with `X-Request-Id`. | Vercel routing misses the **trailing-slash variant** OR the production domain is serving from a Vercel project that is not applying this repo’s `vercel.json`. | Open | Ensure `vercel.json` (repo root) is applied in the production Vercel project (correct root directory, correct project, correct deployment promoted). Then confirm `/grantflow/` redirects to `/grantflow`. |

## Evidence (screenshots)

Screenshots captured during investigation:

- `health-app-grantflow.png`: `app.axiombiolabs.org/grantflow/api/health` returns JSON `{ status: "healthy", dialect: "postgres", ... }`
- `health-www-grantflow-404.png`: `axiombiolabs.org/grantflow/api/health` returns a static 404 page
- `www-grantflow-login-404.png`: `axiombiolabs.org/grantflow/login` returns a static 404 page

Command-line evidence (captured 2026-01-16):

- Run: `node scripts/capture-prod-signatures.mjs`
- Key lines:
  - `https://app.axiombiolabs.org/grantflow/` → `404` (`Server: Vercel`, `NOT_FOUND`)
  - `https://app.axiombiolabs.org/grantflow/login` → `200` (HTML)
  - `https://app.axiombiolabs.org/grantflow/api/health` → `200` (JSON, includes `X-Request-Id`)
  - `https://www.axiombiolabs.org/grantflow/*` → `301` to `https://axiombiolabs.org/grantflow/*`
  - `https://axiombiolabs.org/grantflow/login` → `404` (HTML, `Server: DPS/2.0.0-beta+sha-42b7380`)
  - `https://axiombiolabs.org/grantflow/api/health` → `404` (HTML, `Server: DPS/2.0.0-beta+sha-42b7380`)

Command-line evidence (captured 2026-01-17):

- Run: `SMOKE_BASE_URL=https://app.axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod`
  - Result: **FAIL** because `https://app.axiombiolabs.org/grantflow/` is not OK (trailing slash incident persists).
- Run: `SMOKE_BASE_URL=https://www.axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod`
  - Result: **FAIL** because `https://www.axiombiolabs.org/grantflow/login` returns `404` HTML (domain routing drift).

## Notes / Access Needed

- Vercel logs (production) for the `www.axiombiolabs.org` domain + rewrites config.
- Railway logs around the same timestamps (to confirm whether requests ever reached the backend).
- (Optional) Base44 **reference** export verification failures (if any) to correlate missing config vs missing code.

### Log access requests (copy/paste)

- **Vercel**:
  - Confirm which Vercel project owns `app.axiombiolabs.org` vs `axiombiolabs.org` and whether `vercel.json` is being applied.
  - Export request logs for `GET /grantflow/` and `GET /grantflow/login` around `2026-01-16T04:40Z` (UTC).
- **GoDaddy/DPS (if apex is still there)**:
  - Confirm rewrite capability for `/grantflow/*` (SPA fallback) and proxy support for `/grantflow/api/*`.
- **Railway**:
  - Tail logs for the request id observed on `/grantflow/api/health` (example: `a3873fd0-1d10-4c11-82a6-70ae1d689fc7`) to confirm end-to-end routing.