# Repro Matrix (Routes / Actions / Endpoints)

This document defines **what is exercised by automation** and how to reproduce it locally.

## Repository discovery

- **Frontend root**: `src/` (Vite + React Router)
  - **Entrypoint**: `src/main.jsx` → `src/App.jsx` → `src/pages/index.jsx`
  - **Routing**: `src/pages/index.jsx`
  - **Base path**: `VITE_APP_BASE` (default `/grantflow`)
- **Backend root**: `backend/` (Express + SQLite via better-sqlite3)
  - **Entrypoint**: `backend/server.js`
  - **Health**: `GET /health`
  - **API mount point**: `backend/server.js` mounts routers under `/api/*`
- **Crawler/scripts surface**
  - `backend/routes/crawlers.js` (job queue endpoints under `/api/crawlers/*`)
  - `scripts/*.mjs` (seeders, crawler runners, smoke scripts)
- **Tests surface**
  - **Unit**: `tests/unit/` (Node built-in test runner)
  - **E2E smoke**: `tests/smoke/` (Playwright)

## Commands

- **Doctor (end-to-end)**: `npm run doctor`
- **Smoke only**: `npm run smoke`
- **Backend only**: `npm run backend`
- **Frontend**: `npm run dev` (dev) or `npm run preview` (prod build preview)

## What automation exercises

### Doctor pipeline (`scripts/doctor.mjs`)

Runs in this order and writes logs/artifacts to `artifacts/YYYY-MM-DD/`:

- `npm run lint`
- `npm run typecheck`
- `npm run unit`
- `npm run build`
- start backend (`backend/server.js`) and wait for `GET /health`
- start frontend preview (`npm run preview`) and wait for base path to load
- `npm run smoke` (Playwright)

### UI smoke (`tests/smoke/smoke.spec.mjs`)

- Enumerates routes by parsing `src/pages/index.jsx` for `<Route path="...">`
- For each route:
  - navigates to the page
  - clicks visible controls (buttons/checkboxes/selects/toggles) in a controlled manner
  - captures browser `console.error` and fails if any are emitted

### API smoke (`tests/smoke/smoke.spec.mjs`)

- Calls a small set of core endpoints with an admin token and fails on any 5xx.
- Writes request/response summaries to `artifacts/YYYY-MM-DD/repro/api-calls.json` (responses are truncated).

