## GrantFlow Production Stability Runbook (Vercel + Railway)

This runbook is focused on **deployment sanity**, **database safety**, and **fast rollback**.

---

## Prereqs

- Node **20.20.2** (see `.nvmrc`; Android/iOS tooling is the Node 22 exception)
- `npm ci` works locally
- Access to:
  - Vercel project (frontend)
  - Railway project (backend + Postgres)

---

## 1) Environment Variables (source of truth)

- **Frontend**: `docs/ENVIRONMENT.md` -> "Frontend (Vercel)"
- **Backend**: `docs/ENVIRONMENT.md` -> "Backend (Railway)"

---

## 2) Deploy Flow

### Backend (Railway)

1. **Set variables**
   - `DB_PROVIDER=postgres`
   - `DATABASE_URL=...` (Railway Postgres internal URL)
   - `AUTH_JWT_SECRET=...`
   - `CORS_ORIGIN=...`
   - Optional: `OPENAI_API_KEY`, `RESEND_API_KEY`, `TWILIO_*`

2. **Run migrations (strict for Postgres)**

```bash
npm run migrate
```

3. **Deploy**
   - Push to the branch Railway deploys (or trigger a Railway deployment).

4. **Verify**
   - `GET /readyz` returns `200` with `"status":"ready"`
   - Response indicates Postgres dialect and confirms readiness prerequisites
   - `GET /api/health` returns `200` as the public health summary
   - Login works (email OTP start + verify)
   - Create/update profile works

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

---

## 3) Verification Checklist (production-grade quick pass)

- **Backend**
  - `/readyz` -> `200` with `"status":"ready"`
  - `/api/health` -> `200`
  - at least one **intentional failure** route returns a JSON object with `ok=false` and `request_id`
  - check logs for `X-Request-Id` correlation

- **Frontend**
  - open Dashboard -> no blank screen
  - navigate to Admin/Diagnostics -> loads (may take a moment; should show loading state)
  - force a route error (optional dev step) -> error boundary renders recovery UI

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
  - check `/readyz`, `/api/health`, and server logs using `request_id`

- **Blank screen**
  - route-level ErrorBoundary should now show a recovery UI
  - check browser console for `[RouteErrorBoundary]` log
