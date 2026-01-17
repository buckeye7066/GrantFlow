## GrantFlow Cloud Deployment (Vercel + Railway)

This playbook captures everything needed to ship GrantFlow to production at `https://www.axiombiolabs.org/grantflow`, using **Vercel** for the SPA and **Railway** for the API.

---

### 1. Branch & Local Verification

1. Check out the deployment branch and pull latest.
   ```bash
   git checkout stabilization/doctor-gate
   git pull
   ```
2. Make sure nothing is uncommitted.
   ```bash
   git status
   ```
3. Run the standard quality gates.
   ```bash
   npm run doctor
   ```
   If `npm run doctor` passes, you have a consistent build + backend + smoke baseline.

---

### 2. Frontend Deployment (Vercel)

1. **Create or select** the Vercel project for GrantFlow.
2. **Repository:** connect to the GitHub repo and choose the branch you deploy from (recommended: `main` after stabilization merges).
3. **Framework preset:** `Vite`.
4. **Build & output settings:**
   - Install command: `npm install`
   - Build command: `npm run build`
   - Output directory: `dist`
5. **Environment variables** (Project Settings → Environment Variables):
   - `VITE_APP_BASE=/grantflow`
   - (optional, dev-only) `VITE_API_URL=https://grantflow-production.up.railway.app`
6. **Routing:** we already ship `vercel.json` with:
   ```json
   {
     "redirects": [
       { "source": "/", "destination": "/grantflow", "permanent": false }
     ],
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://grantflow-production.up.railway.app/api/:path*" },
       { "source": "/grantflow/api/:path*", "destination": "https://grantflow-production.up.railway.app/api/:path*" },
       { "source": "/grantflow", "destination": "/index.html" },
       { "source": "/grantflow/:path*", "destination": "/index.html" }
     ]
   }
   ```
   This ensures the SPA works from `/grantflow/*` and API calls proxy cleanly when needed.
   - **Critical:** The production domain must handle both `/grantflow` **and** `/grantflow/` (trailing slash).  
     If `/grantflow` works but `/grantflow/` returns `404 NOT_FOUND`, your Vercel deployment is **not applying this repo’s `vercel.json`** (wrong project, wrong root directory, or stale promotion).
7. Trigger a deploy. Vercel will build and host the static bundle automatically.
8. **Domains:** ensure **both** `app.axiombiolabs.org` and `www.axiombiolabs.org` (if you expect them to work) are attached to this Vercel project.
   - If `app.*` works but `www.*` 404s on deep links, see **E-001** in `docs/ERROR_LEDGER.md`.

---

### 3. Backend Deployment (Railway)

1. **Project setup:** this repo ships `railway.json` and a root `Dockerfile`. Railway should build from the repo root.
2. **Environment variables** (Railway → Variables):
   See `docs/ENVIRONMENT.md` (backend section). At minimum:
   - `DB_PROVIDER` + (`DATABASE_URL` for Postgres **or** `SQLITE_DB_PATH` for SQLite)
   - `AUTH_JWT_SECRET`
   - `CORS_ORIGIN`
   - `ADMIN_TOKEN`
3. **Seed the database** (pick one):
   - _Pre-built_: unzip `grantflow-migration.zip` into `backend/data/` before the container starts.
   - _JSON import (optional)_: if you have a **Base44 reference export** (dataset), copy it into `backend/`, then run `node backend/import-data.js data-export.json`.
4. **Start command:** Railway uses `railway.json` → `npm start` (which runs `node backend/server.js`).
5. **Check logs:** confirm `/api/health` returns `200` and logs show a healthy DB connection.

---

### 4. Merge & Release

1. Open a PR into `main` (recommended) once the stabilization branch is verified.
2. Once approved, merge to `main`. Vercel/Railway will auto-build if configured.
3. In Vercel, promote the new build to production (`Production Deployments → Promote`).
4. DNS: ensure `www.axiombiolabs.org` points to Vercel (not GoDaddy default hosting). See E-001.

---

### 5. Post-Deployment Verification

1. Run the smoke test against the production URL:
   ```bash
   SMOKE_BASE_URL=https://<your-vercel-app>.vercel.app npm run smoke:login
   ```
2. Visit `https://<your-vercel-app>.vercel.app/grantflow/login`, enter the admin token, and confirm the dashboard renders data.
3. Hit the health check directly:
   ```bash
   curl https://grantflow-production.up.railway.app/api/health
   ```
4. Verify the **canonical profile schema** endpoint (used for completeness + matching):
   - `GET https://<vercel-domain>/grantflow/api/profiles/schema`
   - The read-only production smoke checker (`npm run smoke:prod`) also validates this endpoint by default.
     - Disable with: `SMOKE_CHECK_PROFILE_SCHEMA=false`
5. Verify profile completeness + repair endpoints on at least one real profile:
   - `GET https://<vercel-domain>/grantflow/api/profiles/<profile_id>/completeness`
   - `POST https://<vercel-domain>/grantflow/api/profiles/<profile_id>/repair`
6. Verify billing tiers proxy works (BillingSheet uses these rates):
   - `GET https://<vercel-domain>/grantflow/api/billing/tiers`
7. Spot-check key flows (pipeline, documents upload, billing) to confirm the Railway backend responds as expected.

---

### 6. Troubleshooting Quick Reference

| Symptom                               | Fix |
|--------------------------------------|-----|
| `/grantflow/*` returns 404            | Verify the `vercel.json` rewrites and that the deployment picked them up. |
| `/grantflow` works but `/grantflow/` 404s | Vercel is not applying this repo’s `vercel.json`. Confirm the correct Vercel project + root directory, then redeploy/promote. |
| API calls rejected (CORS)             | Ensure Railway `CORS_ORIGIN` includes the exact Vercel domain. |
| Playwright smoke test fails locally   | Remember to set `SMOKE_BASE_PATH=/grantflow` or drop it entirely in production where rewrites handle the prefix. |
| Backend can’t find DB                 | Confirm `grantflow.db` exists under `backend/data/` and `DATABASE_URL` points to it. |
| Login redirects unexpectedly          | Set `ADMIN_TOKEN` in Railway and use that value during sign-in. |

---

### 7. Rollback

1. Revert the merge in GitHub (creates a new commit undoing `resolve-merge-conflicts`).
2. Vercel auto-redeploys the previous production build; promote it if necessary.
3. Railway keeps serving the existing database—no action required unless you changed data.

---

### 8. Useful Commands

```bash
# Lint + build + smoke (one liner)
npm run lint && npm run build && SMOKE_BASE_URL=https://<preview>.vercel.app npm run smoke:login

# Tail backend logs on Railway locally
railway logs -s grantflow-backend

# Generate secure admin token
openssl rand -hex 32
```

Keep this doc close when cutting releases—updating it after each deploy will keep the team aligned.

