# Repro Matrix (Routes / Actions / Endpoints)

This document describes the automated coverage provided by `npm run doctor` and `npm run smoke`.

## Repo discovery

- **Frontend**
  - Root: `src/`
  - Entrypoint: `src/main.jsx` → `src/App.jsx` → `src/pages/index.jsx`
  - Router config: `src/pages/index.jsx`
  - Base path: `VITE_APP_BASE` (default `/grantflow`)
- **Backend**
  - Root: `backend/`
  - Entrypoint: `backend/server.js`
  - Health: `GET /health`
  - API mount point: `backend/server.js` mounts routers under `/api/*`
- **Crawler surface**
  - Script entrypoints: `scripts/crawler-smoke.mjs`, `scripts/crawler-run.mjs`, `scripts/crawler-doctor.mjs`
  - HTTP entrypoint: `POST /api/crawler-v2/run` (see `backend/routes/crawlerV2.js`)
- **Scripts**
  - Root: `scripts/`
  - Doctor runner: `scripts/doctor.mjs` (+ helpers under `scripts/_doctor/`)
- **Tests**
  - UI + API smoke: `tests/smoke/` (Playwright)
  - Unit tests: `tests/unit/` (Node built-in test runner)

## How to run

- **Doctor (end-to-end)**: `npm run doctor`
- **Smoke only**: `npm run smoke`

## What is exercised

### Doctor pipeline (`scripts/doctor.mjs`)

1. Generates env inventory: `node scripts/inventory-env.mjs` → `docs/ENV_VARS.md`
2. Lint: `npm run lint`
3. Typecheck: `npm run typecheck`
4. Unit tests: `npm run unit`
5. Production build: `npm run build` (doctor writes output under `artifacts/YYYY-MM-DD/dist/` for reproducibility)
6. Starts backend (Express): `node backend/server.js` (doctor selects an available port 8080/8081/8082)
7. Starts frontend (Vite dev): `npm run dev` (doctor selects an available port 5173/5174/5175)
8. Runs Playwright smoke (UI on Vite dev + API on Express): `npm run smoke`

### Smoke suite (`tests/smoke/smoke.spec.mjs`)

- **Routes**: parsed from `src/pages/index.jsx` by extracting `<Route path="...">` strings
- **UI actions**:
  - visit selected routes under `${SMOKE_UI_BASE_URL}${SMOKE_BASE_PATH}`
  - click visible UI controls in a controlled way (skips destructive keywords)
  - fail on any browser `console.error`
- **API actions**:
  - discovers endpoints by parsing `backend/server.js` (mount points) + `backend/routes/*.js` (`router.get/post/...`)
  - calls every discovered endpoint with minimal safe payloads
  - allows 4xx (auth/validation/404) but fails on any 5xx
  - triggers a deterministic crawler run via `POST /api/crawler-v2/run` (fixtures/offline; admin bulk key)

### Artifacts

Doctor writes evidence to:

- `artifacts/YYYY-MM-DD/`
  - `lint.log`, `typecheck.log`, `test.log`, `build.log`
  - `backend.log`
  - `frontend.log`
  - `smoke.log`
  - `playwright-report/` + `playwright-output/` (traces/screenshots/videos on failures)
  - `repro/` (routes/actions and console errors JSON)

