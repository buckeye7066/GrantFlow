## GrantFlow Production Stability Runbook (Vercel + Railway)

This runbook is focused on **deployment sanity**, **database safety**, and **fast rollback**.

---

## Prereqs

- Node **20.x** (see `.nvmrc`)
- `npm ci` works locally
- Access to:
  - Vercel project (frontend)
  - Railway project (backend + Postgres)

---

## 1) Environment Variables (source of truth)

- **Frontend**: `docs/ENVIRONMENT.md` → “Frontend (Vercel)”
- **Backend**: `docs/ENVIRONMENT.md` → “Backend (Railway)”

---

## 2) Deploy Flow

### Backend (Railway)

1. **Set variables**
   - `DB_PROVIDER=postgres`
   - `DATABASE_URL=...` (Railway Postgres internal URL)
   - `AUTH_JWT_SECRET=...` (**required**; must NOT be `grantflow-dev-secret`)
   - `CORS_ORIGIN=...`
   - `RESEND_API_KEY=...` (**required** for email OTP)
   - `FROM_EMAIL=...` (**required** for email OTP)
   - `OPENAI_API_KEY=...` (**required** for Anya + AI enrichment; core app still boots without it but AI is degraded)
   - Recommended: `OPENAI_TIMEOUT_MS=20000`, `OPENAI_MAX_RETRIES=2`
   - Optional: `TWILIO_*` (only required for SMS OTP)
   - Optional: `CRAWLER_SCHEDULER_ENABLED=true` (runs cron schedules from `crawler_schedules`)
   - Optional: `CRAWLER_SCHEDULER_INTERVAL_MS=60000`

2. **Run migrations (strict for Postgres)**

```bash
npm run migrate
```

3. **Deploy**
   - Push to the branch Railway deploys (or trigger a Railway deployment).

4. **Verify**
   - `GET /api/health` returns `200`
   - Response indicates Postgres dialect (and no DB error details)
   - Login works (email OTP start + verify)
   - Create/update profile works
   - Admin diagnostics works: `GET /api/admin/diagnostics` (admin only)
   - Build metadata is correct: `GET /api/meta/build` includes git sha

### Frontend (Vercel)

1. **Set variables**
   - `VITE_APP_BASE=/grantflow`
   - (optional) `VITE_API_URL` in development only

2. **Deploy**
   - Vercel deploy from main (or your configured branch).

3. **Verify**
   - App loads (no blank screen)
   - Navigation works across heavy routes (Admin/Diagnostics/etc.)
   - API calls succeed (no CORS errors)
   - Deep link refresh works at `/grantflow/*` routes
   - Canonical domain: `www.axiombiolabs.org/grantflow` serves the SPA after DNS cutover

### DNS (GoDaddy) — make `www.axiombiolabs.org/grantflow` work

If `https://axiombiolabs.org/grantflow/*` shows a GoDaddy 404, the apex is not serving the SPA.
GrantFlow should be served from Vercel via `www`:

- GoDaddy DNS: set **`CNAME`** `www` → **`cname.vercel-dns.com`**
- Keep `app` CNAME pointing at Vercel (already configured)

---

## 3) Verification Checklist (production-grade quick pass)

- **Backend**
  - `/api/health` → `200`
  - at least one **intentional failure** route returns a JSON object with `ok=false` and `request_id`
  - check logs for `X-Request-Id` correlation

- **Frontend**
  - open Dashboard → no blank screen
  - navigate to Admin/Diagnostics → loads (may take a moment; should show loading state)
  - force a route error (optional dev step) → error boundary renders recovery UI

---

## 4) Rollback

### Backend rollback (fast)

- **Rollback deploy**: redeploy previous successful Railway deployment.
- **Rollback DB provider** (only if you must):
  - set `DB_PROVIDER=sqlite`
  - set `SQLITE_DB_PATH=...`
  - redeploy

> Note: this does not reverse Postgres migrations; it switches the app back to SQLite. Use only as a last resort.

### Frontend rollback

- Redeploy the previous Vercel production deployment.

---

## 5) Known Failure Modes + First Response

- **502/Crash loop on backend**
  - check `DB_PROVIDER` and `DATABASE_URL`
  - check `/api/health` and server logs using `request_id`

- **Blank screen**
  - route-level ErrorBoundary should now show a recovery UI
  - check browser console for `[RouteErrorBoundary]` log

