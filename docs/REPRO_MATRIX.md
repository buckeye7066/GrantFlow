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
5. Production build: `npm run build`
6. Starts backend: `node backend/server.js` (doctor selects an available port)
7. Runs Playwright smoke: `npm run smoke`

### Smoke suite (`tests/smoke/smoke.spec.mjs`)

- **Routes**: parsed from `src/pages/index.jsx` by extracting `<Route path="...">` strings
- **UI actions**:
  - visit selected routes under `${SMOKE_BASE_URL}${SMOKE_BASE_PATH}`
  - click visible UI controls in a controlled way (skips destructive keywords)
  - fail on any browser `console.error`
- **API actions**:
  - calls key endpoints and fails on any 5xx

### Artifacts

Doctor writes evidence to:

- `artifacts/YYYY-MM-DD/`
  - `lint.log`, `typecheck.log`, `test.log`, `build.log`
  - `backend.log`
  - `smoke.log`
  - `playwright-report/` + `playwright-output/` (traces/screenshots/videos on failures)
  - `repro/` (routes/actions and console errors JSON)

