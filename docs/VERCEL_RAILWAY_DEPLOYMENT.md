## GrantFlow Cloud Deployment (Vercel + Railway)

This playbook captures everything needed to ship the `resolve-merge-conflicts` branch to production at `https://www.axiombiolabs.org/grantflow`, using **Vercel** for the SPA and **Railway** for the API.

---

### 1. Branch & Local Verification

1. Check out the deployment branch and pull latest.
   ```bash
   git checkout resolve-merge-conflicts
   git pull
   ```
2. Make sure nothing is uncommitted.
   ```bash
   git status
   ```
3. Run the standard quality gates.
   ```bash
   npm install
   npm run lint
   npm run build
   npm run preview -- --host 127.0.0.1 --port 4176 &
   SMOKE_BASE_URL=http://127.0.0.1:4176 SMOKE_BASE_PATH=/grantflow SMOKE_TARGET_PATH= npm run smoke:login
   ```
   Stop the preview server once the smoke test passes.

---

### 2. Frontend Deployment (Vercel)

1. **Create or select** the Vercel project for GrantFlow.
2. **Repository:** connect to the GitHub repo and choose the `resolve-merge-conflicts` branch (switch to `main` once merged).
3. **Framework preset:** `Vite`.
4. **Build & output settings:**
   - Install command: `npm install`
   - Build command: `npm run build`
   - Output directory: `dist`
5. **Environment variables** (Project Settings → Environment Variables):
   - `VITE_API_URL=https://grantflow-production.up.railway.app` (or your final backend URL)
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
7. Trigger a deploy. Vercel will build and host the static bundle automatically.

---

### 3. Backend Deployment (Railway)

1. **Project setup:** create a Railway service from the repo root or from the `backend` folder.
2. **Environment variables** (Railway → Variables):
   | Key              | Value (example)                               |
   | ---------------- | --------------------------------------------- |
   | `PORT`           | `8080`                                        |
   | `DATABASE_URL`   | `./data/grantflow.db`                         |
   | `ADMIN_TOKEN`    | Secure random value (`openssl rand -hex 32`)  |
   | `CORS_ORIGIN`    | `https://your-vercel-app.vercel.app`          |
   | `OPENAI_API_KEY` | *(optional – required for AI features)*       |
3. **Seed the database** (pick one):
   - _Pre-built_: unzip `grantflow-migration.zip` into `backend/data/` before the container starts.
   - _JSON import_: copy your Base44 export into `backend/`, then run `node backend/import-data.js data-export.json`.
4. **Start command:** `node backend/server.js`.
5. **Check logs:** confirm `GrantFlow API server running on port 8080` appears with no stack traces.

---

### 4. Merge & Release

1. Open a PR (`resolve-merge-conflicts` ➝ `main`) using the template in `PR_DESCRIPTION.md`.
2. Once approved, merge to `main`. Vercel auto-builds the production deployment.
3. In Vercel, promote the new build to production (`Production Deployments → Promote`).
4. DNS for `www.axiombiolabs.org` is managed by Vercel. Ensure your domain is properly configured in the Vercel project settings.

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

