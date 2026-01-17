# GrantFlow Baseline Inventory (Phase 0.10.3)

**Last updated:** 2026-01-15

This document inventories the current GrantFlow repo: stack, entrypoints, routes, crawler triggers, and DB/migrations. It is intended to be a stable baseline for production readiness work.

## Stack (at a glance)

- **Frontend**: React + Vite + React Router + TanStack Query
- **Backend**: Node (ESM) + Express
- **DB**: SQLite (default) or Postgres (auto-detected when `DATABASE_URL` is postgres), via `backend/db/index.js`
- **AI**: OpenAI (`openai` SDK) + Anthropic (Anya tooling)
- **E2E Smoke**: Playwright (see `tests/smoke`)

## Entrypoints

- **Frontend runtime**: `src/main.jsx`  renders `src/App.jsx`
- **Frontend app/router**: `src/App.jsx`  `BrowserRouter basename=...`  `src/pages/index.jsx`
- **Backend server**: `backend/server.js`
- **DB migrations**: `backend/db/migrate.js` (unified sqlite + postgres runner)
- **Local quality gate**: `scripts/doctor.mjs` (lint/typecheck/unit/build/backend+smoke)

## Frontend Routes (React Router)

The router tree is owned by `src/pages/index.jsx` and is wrapped by `BrowserRouter` in `src/App.jsx`.

Public routes:

- `/login`
- `/ServiceApplication`
- `/auth/callback`

Authenticated routes (rendered under the app layout):

- `/` (Dashboard)
- `/Dashboard`
- `/Organizations`
- `/MyProfiles`
- `/Funder`
- `/DiscoverGrants`
- `/SmartMatcher`
- `/ItemFunding`
- `/Pipeline`
- `/Proposals`
- `/Outreach`
- `/GrantDeadline`
- `/Budgets`
- `/Documents`
- `/Calendar`
- `/Reports`
- `/AdvancedAnalytics`
- `/Billing`
- `/Automation`
- `/NewProject`
- `/GrantDetail`
- `/InvoiceView`
- `/CreateInvoice`
- `/NOFOParser`
- `/AIGrantScorer`
- `/BudgetDetail`
- `/PrintPipeline`
- `/OneTimeFix`
- `/DataSources`
- `/SourceRegistry`
- `/BackfillContacts`
- `/Stewardship`
- `/Settings`
- `/Diagnostics`
- `/ComplianceReportDetail`
- `/ProfileMatcher`
- `/SourceDirectory`
- `/FundingOpportunities`
- `/GrantMonitoring`
- `/PrintableApplication`
- `/BillingSheet`
- `/ProfileDetail`
- `/OrganizationProfile`
- `/Admin`

Notes:

- The router basename is derived in `src/App.jsx` from `VITE_APP_BASE` (preferred) or Vites `BASE_URL`.
- Route-level error boundaries exist via `src/components/shared/RouteErrorBoundary.jsx` (wrapped per route in `src/pages/index.jsx`).

## Backend Routes (Express)

Mounted in `backend/server.js`:

- `GET /api/health`
- `GET /api/meta/build`
- `GET /api/pipeline/stats`
- Auth extras:
  - `GET /api/auth/diagnostics`
  - `GET /api/auth/me`

Routers (prefix  file):

- `/api/auth`  `backend/routes/auth.js`
- `/api/service-application`  `backend/routes/serviceApplication.js`
- `/api/billing`  `backend/routes/billing.js`
- `/api/stats`  `backend/routes/stats.js`
- `/api/organizations`  `backend/routes/organizations.js`
- `/api/grants`  `backend/routes/grants.js`
- `/api/opportunities`  `backend/routes/opportunities.js`
- `/api/programs`  `backend/routes/programs.js`
- `/api/milestones`  `backend/routes/milestones.js`
- `/api/documents`  `backend/routes/documents.js`
- `/api/expenses`  `backend/routes/expenses.js`
- `/api/ai`  `backend/routes/ai.js`
- `/api/anya`  `backend/routes/anya.js`
- `/api/profiles`  `backend/routes/profiles.js`
- `/api/reminders`  `backend/routes/reminders.js`
- `/api/matching`  `backend/routes/matching.js`
- `/api/grant-monitoring`  `backend/routes/grantMonitoring.js`
- `/api/crawlers`  `backend/routes/crawlers.js`
- `/api/real-crawlers`  `backend/routes/realCrawlers.js`
- `/api/preferences`  `backend/routes/preferences.js`
- `/api/admin`  `backend/routes/admin.js`
- `/api` (discovery endpoints)  `backend/routes/discovery.js`
- `/api/crawler-v2`  `backend/routes/crawlerV2.js`
- `/api/nf-programs`  `backend/routes/nfPrograms.js`

## Crawlers (triggers & surfaces)

Admin/HTTP triggers:

- `POST /api/crawlers` (queue jobs; see `backend/routes/crawlers.js`)
- Additional legacy / real crawler routes live in `backend/routes/realCrawlers.js`

Script triggers (manual / ops):

- `scripts/crawler-run.mjs`, `scripts/crawler-smoke.mjs`, `scripts/crawler-doctor.mjs`
- `scripts/nationwide-comprehensive-crawl.mjs`, `scripts/extended-state-crawler.mjs`
- `scripts/run-crawlers.mjs`, `scripts/run-all-real-crawlers.mjs`, etc.

## Database & Migrations

Provider selection:

- Uses **Postgres** when `DB_PROVIDER=postgres` OR when `DATABASE_URL` is a `postgres://` URL.
- Otherwise defaults to **SQLite** at `backend/data/grantflow.db` (or `SQLITE_DB_PATH`).

Migrations:

- Run via `node backend/db/migrate.js` (`npm run migrate`)
- Migration directories:
  - SQLite: `backend/db/migrations/*.sql`
  - Postgres: `backend/db/postgres/migrations/*.sql`