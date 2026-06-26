## GrantFlow Cloud Deployment (Vercel + Railway)

This playbook captures everything needed to ship GrantFlow to production at `https://axiombiolabs.org/grantflow` and `https://www.axiombiolabs.org/grantflow`, using **Vercel** for the SPA and **Railway** for the API.

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
       { "source": "/uploads/:path*", "destination": "https://grantflow-production.up.railway.app/uploads/:path*" },
       { "source": "/grantflow/uploads/:path*", "destination": "https://grantflow-production.up.railway.app/uploads/:path*" },
       { "source": "/grantflow", "destination": "/index.html" },
       { "source": "/grantflow/:path*", "destination": "/index.html" }
     ]
   }
   ```
   This ensures the SPA works from `/grantflow/*` and API calls proxy cleanly when needed.
7. Trigger a deploy. Vercel will build and host the static bundle automatically.
8. **Domains:** ensure `axiombiolabs.org`, `www.axiombiolabs.org`, and `app.axiombiolabs.org` (if you still use it) are attached to this Vercel project.
   - If `app.*` works but `www.*` 404s on deep links, see **E-001** in `docs/ERROR_LEDGER.md`.

---

### 3. Backend Deployment (Railway)

1. **Project setup:** this repo ships `railway.json` and a root `Dockerfile`. Railway should build from the repo root.
2. **Environment variables** (Railway → Variables):
   See `docs/ENVIRONMENT.md` and `docs/ENV_VARS.md` for the full inventory. At minimum:
   | Key              | Value (example)                               |
   | ---------------- | --------------------------------------------- |
   | `PORT`           | `8080`                                        |
   | `DATABASE_URL`   | `./data/grantflow.db`                         |
   | `UPLOADS_DIR`    | `/data/uploads` (or your mounted volume path) |
   | `ADMIN_TOKEN`    | Secure random value (`openssl rand -hex 32`)  |
   | `CORS_ORIGIN`    | `https://your-vercel-app.vercel.app`          |
   | `OPENAI_API_KEY` | *(optional – required for AI features)*       |
3. **Persistent uploads volume (required)**:
   - Add a Railway **Volume** and mount it (recommended mount path: `/data`)
   - Set `UPLOADS_DIR=/data/uploads`
   - After first deploy, confirm `/readyz` returns 200 and includes uploads write access (it will return 503 if the mount is missing/unwritable).
3. **Seed the database** (pick one):
   - _Pre-built_: unzip `grantflow-migration.zip` into `backend/data/` before the container starts.
4. **Start command:** Railway uses `railway.json` → `npm start` (which runs `node backend/server.js`).
5. **Check logs:** confirm `/api/health` returns `200` and logs show a healthy DB connection.

---

### 4. Merge & Release

1. Open a PR into `main` (recommended) once the stabilization branch is verified.
2. Once approved, merge to `main`. Vercel/Railway will auto-build if configured.
3. In Vercel, promote the new build to production (`Production Deployments → Promote`).
4. DNS: ensure `axiombiolabs.org` and `www.axiombiolabs.org` point to Vercel (not GoDaddy default hosting). See E-001.
   - Expected apex record: `axiombiolabs.org A 76.76.21.21`
   - Expected `www` record: `www.axiombiolabs.org CNAME cname.vercel-dns-0.com`
   - Manual GitHub path: Actions -> Apply GoDaddy DNS for Vercel -> Run workflow -> `confirm=YES`
   - Local dry-run path: `GODADDY_DOMAIN=axiombiolabs.org npm run dns:godaddy:vercel`
   - Local apply path requires `GODADDY_API_KEY`, `GODADDY_API_SECRET`, and `CONFIRM=YES`.

---

### 5. Post-Deployment Verification

1. Run the smoke test against both production hosts:
   ```bash
   SMOKE_BASE_URL=https://axiombiolabs.org npm run smoke:prod
   SMOKE_BASE_URL=https://www.axiombiolabs.org npm run smoke:prod
   ```
2. Visit `https://<your-vercel-app>.vercel.app/grantflow/login`, enter the admin token, and confirm the dashboard renders data.
3. Hit the health check directly:
   ```bash
   curl https://grantflow-production.up.railway.app/api/health
   ```
4. Spot-check key flows (pipeline, documents upload, billing) to confirm the Railway backend responds as expected.

---

### 6. Troubleshooting Quick Reference

| Symptom                               | Fix |
|--------------------------------------|-----|
| `/grantflow/*` returns 404            | Verify the `vercel.json` rewrites and that the deployment picked them up. |
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
