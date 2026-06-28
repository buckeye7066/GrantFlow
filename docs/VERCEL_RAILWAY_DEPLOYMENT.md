## GrantFlow Cloud Deployment (Vercel + Railway)

This playbook captures the supported production path for GrantFlow using **Vercel** for the SPA and **Railway** for the API. Use only the app/subdomain routes intentionally attached to Vercel; do not repoint the Axiom BioLabs lab-site apex unless that takeover is deliberate and approved.

---

### 1. Branch & Local Verification

1. Check out the deployment branch and pull latest.
   ```bash
   git checkout main
   git pull
   ```
2. Make sure nothing is uncommitted.
   ```bash
   git status
   ```
3. Run the local deployment/config gates.
   ```bash
   npm run doctor
   npm run deployment-config:check
   ```
   Passing local checks prove only the local checkout/config shape. Do not label production healthy until the deployed Vercel and Railway services are checked directly.

---

### 2. Frontend Deployment (Vercel)

1. **Create or select** the Vercel project for GrantFlow.
2. **Repository:** connect to the GitHub repo and choose the branch you deploy from.
3. **Framework preset:** `Vite`.
4. **Build & output settings:**
   - Install command: `npm ci --include=optional`
   - Build command: `npm run build`
   - Output directory: `dist`
5. **Environment variables** (Project Settings -> Environment Variables):
   - `VITE_APP_BASE=/grantflow`
   - Do not set production `VITE_API_URL` unless you intentionally want cross-origin API calls. The normal production path uses same-origin `/api/*` rewrites.
6. **Routing:** this repo ships `vercel.json` with `trailingSlash: false`, API/upload rewrites to Railway, and SPA fallbacks for both `/grantflow/*` and root deep links:
   ```json
   {
     "trailingSlash": false,
     "rewrites": [
       { "source": "/grantflow/api/:path*", "destination": "https://grantflow-production.up.railway.app/api/:path*" },
       { "source": "/api/:path*", "destination": "https://grantflow-production.up.railway.app/api/:path*" },
       { "source": "/grantflow/uploads/:path*", "destination": "https://grantflow-production.up.railway.app/uploads/:path*" },
       { "source": "/uploads/:path*", "destination": "https://grantflow-production.up.railway.app/uploads/:path*" },
       { "source": "/grantflow/((?!assets/).*)", "destination": "/index.html" },
       { "source": "/((?!assets/).*)", "destination": "/index.html" }
     ]
   }
   ```
7. Trigger a deploy. Vercel will build and host the static bundle automatically.
8. **Domains:** ensure every expected GrantFlow production host is attached to this Vercel project. If `app.*`, `www.*`, or another approved GrantFlow host 404s on deep links, see **E-001** in `docs/ERROR_LEDGER.md`.

---

### 3. Backend Deployment (Railway)

1. **Project setup:** this repo ships `railway.json` and a root `Dockerfile`. Railway should build from the repo root.
2. **Environment variables** (Railway -> Variables):
   See `docs/ENVIRONMENT.md` for the full inventory. At minimum:

   | Key               | Value (example)                                      |
   | ----------------- | ---------------------------------------------------- |
   | `PORT`            | `8080`                                               |
   | `DB_PROVIDER`     | `postgres`                                           |
   | `DATABASE_URL`    | `postgres://...` Railway Postgres internal URL       |
   | `AUTH_JWT_SECRET` | Secure random value (`openssl rand -hex 32`)         |
   | `UPLOADS_DIR`     | `/data/uploads` (or your mounted volume path)        |
   | `CORS_ORIGIN`     | Exact Vercel/custom origins allowed to call the API  |
   | `OPENAI_API_KEY`  | Optional; required for OpenAI-backed AI features     |

3. **Persistent uploads volume (required):**
   - Add a Railway **Volume** and mount it (recommended mount path: `/data`).
   - Set `UPLOADS_DIR=/data/uploads`.
   - Railway readiness uses `/readyz`; it returns 503 if DB, schema, JWT secret, or uploads prerequisites are not ready.
4. **Migrate the database:**
   ```bash
   DB_PROVIDER=postgres DATABASE_URL="<railway-postgres-url>" npm run migrate
   ```
5. **Start command:** Railway uses `railway.json` -> `npm start` (which runs `node backend/start.js`).
6. **Health/readiness:**
   - `/readyz` is the Railway deploy readiness gate.
   - `/api/health` is the public health summary/liveness-style endpoint and is not enough to prove production readiness by itself.

---

### 4. Merge & Release

1. Open a PR into the deploy branch once the local gates pass.
2. Once approved, merge to `main`. Vercel/Railway will auto-build if configured.
3. In Vercel, promote the new build to production if your project does not auto-promote.
4. DNS: ensure expected GrantFlow production hosts point to Vercel, not registrar/default hosting. Do not point `axiombiolabs.org` apex at Vercel while the lab website lives on GoDaddy. See E-001 in `docs/ERROR_LEDGER.md`.
3. In Vercel, promote the new build to production (`Production Deployments → Promote`).
   - Preferred GrantFlow host: subdomain/CNAME to `cname.vercel-dns-0.com`.
   - Manual GitHub path: Actions -> Apply GoDaddy DNS for Vercel -> Run workflow -> `confirm=YES`
   - Local dry-run path: `GODADDY_DOMAIN=axiombiolabs.org npm run dns:godaddy:vercel`
   - Local apply path requires `GODADDY_API_KEY`, `GODADDY_API_SECRET`, and `CONFIRM=YES`; apex takeover also requires `ALLOW_LAB_APEX_TAKEOVER=I_UNDERSTAND`.

---

### 5. Post-Deployment Verification

Run these only against the actual deployed hosts you intend to call healthy:

```bash
curl -fsS https://grantflow-production.up.railway.app/readyz
SMOKE_BASE_URL=https://app.axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod
SMOKE_BASE_URL=https://www.axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod
# Only run an apex smoke if the apex is intentionally serving GrantFlow.
# SMOKE_BASE_URL=https://axiombiolabs.org SMOKE_BASE_PATH=/grantflow npm run smoke:prod
```

Record failures as missing evidence or open incidents. A local smoke, offline proof, or successful build is not proof that the exact production deployment is healthy.

Also spot-check key flows (pipeline, documents upload, billing) to confirm the Railway backend responds as expected.

---

### 6. Troubleshooting Quick Reference

| Symptom                               | Fix |
|--------------------------------------|-----|
| `/grantflow/*` returns 404            | Verify the deployed Vercel project picked up this repo's `vercel.json`. |
| API calls rejected (CORS)             | Ensure Railway `CORS_ORIGIN` includes the exact browser origin. |
| Railway deploy never becomes healthy  | Check `/readyz`, Railway logs, `DATABASE_URL`, `AUTH_JWT_SECRET`, migrations, and uploads volume. |
| Playwright smoke test fails locally   | Set `SMOKE_BASE_PATH=/grantflow` when testing a prefixed deployment. |
| Backend cannot connect to DB          | Confirm `DB_PROVIDER=postgres` and `DATABASE_URL` points to Railway Postgres. |

---

### 7. Rollback

1. Revert the merge in GitHub or promote the previous known-good Vercel deployment.
2. Redeploy the previous successful Railway deployment.
3. Do not claim rollback success until `/readyz` and the production smoke checks pass against the live hosts.

---

### 8. Useful Commands

```bash
# Local config guard used by release gates
npm run deployment-config:check

# Tail backend logs on Railway locally
railway logs -s grantflow-backend

# Generate secure app secrets
openssl rand -hex 32
```

Keep this doc close when cutting releases; updating it after each deploy keeps the team aligned with the actual production path.
Keep this doc close when cutting releases—updating it after each deploy will keep the team aligned.
