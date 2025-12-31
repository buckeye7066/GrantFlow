## GrantFlow Production Merge – `resolve-merge-conflicts` → `main`

### Overview
- Integrates the production-ready GrantFlow workspace and backend bridge.
- Keeps all `feat/production-readiness` snapshots while pulling in `main`’s security and infrastructure updates.
- Verifies lint, build, and smoke coverage before promoting to production.

### Branches
- Source: `resolve-merge-conflicts`
- Target: `main`
- Merge base: `1f19d1f` (feat/production-readiness)
- Merge commit on branch: `9f203d0`
- Latest commit: `9467fe8`

### Verification
- `npm run lint` → **PASS** (0 errors, 6 known react-refresh warnings from shadcn/ui patterns)
- `npm run build` → **PASS** (Vite build output in `dist/`)
- `npm run preview -- --host 127.0.0.1 --port 4176 &`
- `SMOKE_BASE_URL=http://127.0.0.1:4176 SMOKE_BASE_PATH=/grantflow SMOKE_TARGET_PATH= npm run smoke:login` → **PASS**

### Deployment Notes
- `vercel.json` already redirects `/` → `/grantflow` and rewrites `/grantflow/*` to the SPA.
- Set `VITE_API_URL` in Vercel to your Railway backend (`https://grantflow-production.up.railway.app`).
- Railway backend expects `DATABASE_URL=./data/grantflow.db` and a seeded `grantflow.db` (see `grantflow-migration.zip`).
- Post-merge smoke test: `SMOKE_BASE_URL=https://<vercel-app>.vercel.app npm run smoke:login`.

### Checklist
- [ ] Merge PR once lint, build, and smoke checks succeed in CI.
- [ ] Promote the new Vercel deployment to production.
- [ ] Confirm Railway backend is healthy (`/api/health`).
- [ ] Navigate to `https://www.axiombiolabs.org/grantflow/login` and verify the dashboard renders.
- [ ] Document any production anomalies in `docs/VERCEL_RAILWAY_DEPLOYMENT.md`.

### Appendix
- Full cloud deployment playbook: `docs/VERCEL_RAILWAY_DEPLOYMENT.md`
- Database import helper: `backend/import-data.js`
- Smoke script: `scripts/smoke-login.mjs`

