# GrantFlow Architecture Inventory

_Last updated: 2026-01-28_

> **STALE — historical snapshot, not current state.** This document has not
> been updated since 2026-01-28 and predates major subsystem rewrites
> (verified 2026-08-14): the crawler layer described below (`localCrawler.js`,
> `scholarshipCrawler.js`, `comprehensiveCrawler.js`, `itemCrawler.js`) has
> been superseded by `backend/crawler-os/*` (planner, matchEngine, per-agent
> crawlers under `backend/crawler-os/agents/`); "Stripe integration not
> present yet" is now FALSE — `backend/routes/stripe.js`,
> `backend/routes/stripeWebhook.js`, and a full pricing/catalog subsystem
> exist (see `docs/PRICING_STRIPE_HARDENING.md`); Anya is no longer a
> placeholder chat response (see `backend/services/anyaOrchestrator.js` and
> `backend/services/anyaToolRegistry.js`, which now expose a large tool
> catalog). Treat every claim below as unverified against current code;
> `docs/CRAWLER_ARCHITECTURE.md` and `CLAUDE.md` are closer to current truth
> for the crawler/matching subsystem.

This document inventories the current GrantFlow system **as implemented** (not as intended), including stack, modules, routes, data models, and key UI surfaces/actions.

## Tech stack detection

### Frontend
- **Framework**: React 18
- **Build/dev**: Vite
- **Routing**: React Router (`react-router-dom`)
- **State/data**: Zustand, TanStack Query
- **UI**: Tailwind + shadcn/ui (Radix)
- **E2E tooling (present)**: Playwright smoke scripts (`scripts/smoke-*.mjs`)

### Backend
- **Runtime**: Node.js (ESM)
- **Framework**: Express
- **DB**: SQLite via `better-sqlite3`
- **Auth**: JWT + refresh tokens stored hashed in DB; plus legacy admin token + legacy profile-token support

### Deployment
- **Backend**: Railway (persistent volume for SQLite + uploads), optionally DigitalOcean + systemd + nginx (docs present)
- **Frontend**: Vercel (base path `/grantflow`)

## System entrypoints

### Backend HTTP server
- `backend/server.js`
  - mounts `/api/*` routers
  - serves `/uploads/*` and SPA build
  - initializes SQLite schema by executing `backend/db/schema.sql` at startup

### Database schema
- `backend/db/schema.sql`
  - contains tables for orgs, profiles, profile sections, opportunities, grants pipeline, auth tables, billing tiers/accounts, Anya tables, crawler job tables, etc.

### Frontend app
- `src/pages/index.jsx` + router config in `src/pages/Layout.jsx` (see route map below)

## Modules/services and responsibilities

### Backend routes (`backend/routes/*`)

- `auth.js`
  - **Email OTP**: `POST /api/auth/email/start`, `POST /api/auth/email/verify`
  - **Phone OTP**: `POST /api/auth/phone/start`, `POST /api/auth/phone/verify`
  - **OAuth**: `GET /api/auth/:provider/start`, `GET /api/auth/:provider/callback` (google/facebook/yahoo)
  - **Session**: `POST /api/auth/refresh`, `POST /api/auth/logout`

- `profiles.js`
  - `GET /api/profiles` (admin: all profiles; user: only their current profile)
  - `POST /api/profiles` (admin only)
  - `GET /api/profiles/:id` (admin or authorized user; includes sections + billing account)
  - `PUT /api/profiles/:id` (admin or owning profile)
  - `POST /api/profiles/:id/avatar` (upload image)
  - `POST /api/profiles/:id/avatar/ai` (queues `avatar_lookup` crawler job)
  - Sections CRUD:
    - `GET /api/profiles/:id/sections`
    - `GET /api/profiles/:id/sections/:sectionKey`
    - `PUT /api/profiles/:id/sections/:sectionKey`
    - `DELETE /api/profiles/:id/sections/:sectionKey`
  - Section AI helper:
    - `POST /api/profiles/:id/sections/:sectionKey/ai` (OpenAI extraction via prompt templates)

- `organizations.js`
  - CRUD for organizations (client/applicant entities)

- `opportunities.js`
  - Funding opportunities catalog
  - `GET /api/opportunities` with filters (search/state/source/deadlines/is_national/compliance)
  - `POST /api/opportunities` (manual create)
  - `PUT /api/opportunities/:id` (update)
  - `DELETE /api/opportunities/:id` (soft delete)
  - `POST /api/opportunities/bulk` (bulk import)
  - `GET /api/opportunities/meta/sources`, `GET /api/opportunities/meta/states`

- `grants.js`
  - Grants pipeline CRUD + pipeline grouping
  - `GET /api/grants`
  - `GET /api/grants/pipeline`
  - `PATCH /api/grants/:id/status` (drag-and-drop)
  - `POST /api/grants/from-opportunity`
  - Pipeline automation views:
    - `GET /api/grants/automation/summary`
    - `GET /api/grants/:id/automation/events`
    - `GET /api/grants/:id/automation/latest`

- `milestones.js`
  - Milestone CRUD (grant tracking)

- `expenses.js`
  - Expense CRUD (grant spend tracking)

- `documents.js`
  - Document CRUD
  - `POST /api/documents/ingest` enqueues `document_ingest` crawler job

- `reminders.js`
  - Reminders / notifications (used by dashboard)

- `crawlers.js`
  - Crawler job queue and metrics
  - `GET /api/crawlers/jobs`
  - `GET /api/crawlers/jobs/metrics`
  - `GET /api/crawlers/jobs/:id`
  - `POST /api/crawlers/jobs` (enqueue)
  - `POST /api/crawlers/jobs/:id/retry`
  - `POST /api/crawlers/jobs/:id/cancel`
  - `PATCH /api/crawlers/jobs/:id` (admin-only status update)

- `billing.js`
  - Billing tiers + profile billing account management (NOT Stripe yet)
  - `GET /api/billing/tiers`
  - `POST /api/billing/tiers` (admin)
  - `PUT /api/billing/tiers/:id` (admin)
  - `GET /api/billing/accounts` (admin)
  - `GET /api/billing/accounts/:profileId` (admin or owner)
  - `PUT /api/billing/accounts/:profileId` (admin)

- `ai.js`
  - Misc AI endpoints (used by UI tooling pages)

- `anya.js`
  - Anya session/message/task APIs and tool invocation
  - `GET /api/anya/sessions`, `POST /api/anya/sessions`
  - `GET /api/anya/sessions/:id`, `GET/POST /api/anya/sessions/:id/messages`
  - `GET/POST/PATCH /api/anya/sessions/:id/tasks`
  - `GET /api/anya/profiles/:profileId/tasks`
  - `GET /api/anya/tools`, `POST /api/anya/tools/:toolName/invoke`

### Backend services (`backend/services/*`)

- `crawlerDispatcher.js`: pulls `crawler_jobs` rows and runs handler; writes `result_meta`, `result_count`, status transitions
- `localCrawler.js`: local/nearby opportunity matching based on ZIP coordinates and a static JSON catalogue
- `scholarshipCrawler.js`: scholarship matching based on static JSON catalogue and profile signals
- `comprehensiveCrawler.js`: “nationwide crawl” placeholder currently generating template opportunities by ZIP; writes into `funding_opportunities`
- `itemCrawler.js`: item funding matching against static JSON catalogue; profile-driven scoring
- `opportunityInserter.js`: inserts into `funding_opportunities` with dedupe on `(source, source_id)`
- **Crawler → catalog flow**: Geo Crawl, Nationwide Crawl, and live crawler runs persist to `funding_opportunities`; Funding Opportunities page and Discover Grants read from APIs that query this table.
- `profileHelpers.js`: loads profile context and builds profile signals (keywords, demographics, assistance, location, academics)
- `profileEnrichment.js`: AI-based profile section enrichment job (OpenAI)
- `documentIngestion.js`: AI extraction from document text into profile sections (OpenAI)
- `pipelineAutomation.js`: advances grant statuses and records events (AI-assisted)
- `avatarCrawler.js`: AI avatar generation for profile
- `billingAccounts.js`: tier/account model and audit events
- `anyaOrchestrator.js` + `anyaToolRegistry.js`: Anya persistence + tool list/invocation (currently placeholder response for chat)
- `email.js`: verification email sending (Resend)
- `sharedGeo.js`: helper (haversine)

## Auth/login/session handling

Implemented in:
- `backend/server.js` (request auth middleware)
- `backend/routes/auth.js` (OTP + OAuth + refresh/logout)

### Auth modes accepted
- **JWT Bearer access token**: `Authorization: Bearer <jwt>`
  - JWT payload includes `sid` (session id) and optional `profile_id`
  - server verifies token and checks `user_sessions` row by `sid`
- **Admin token** (legacy):
  - `Authorization: Bearer <ADMIN_TOKEN>` accepted if matches env `ADMIN_TOKEN` / `ANYA_ADMIN_TOKEN`
- **Legacy profile token**:
  - if bearer token matches a `profiles.id`, request is treated as that profile user

### Persistence model
- Users stored in `users`
- Sessions stored in `user_sessions` (refresh token hashed)
- Profiles are linked to users via `profiles.user_id`

## Data models/schemas (core tables)

From `backend/db/schema.sql`:

### Identity & access
- `users`
- `user_credentials` (email_otp, phone_otp)
- `user_verification_codes`
- `user_sessions`
- `user_providers` (OAuth bindings)
- `oauth_states` (OAuth state + PKCE verifier)

### Profiles
- `profiles` (may be linked to `users` and/or `organizations`)
- `profile_sections` (JSON blobs keyed by `section_key`)
- `profile_documents` (join table)

### Funding discovery & pipeline
- `funding_opportunities` (catalog that backs “Funding Opportunities / Discover Grants”)
- `grants` (pipeline entries)
- `grant_pipeline_events` (automation audit trail)

### Ops content
- `documents` (includes extracted text and AI summaries)
- `milestones`, `expenses`, `budgets`, `application_drafts`, `contacts`

### Crawler/automation control plane
- `crawler_jobs` (queued/running/completed/failed/cancelled; profile_id + organization_id + parameters + result_meta)
- `crawl_logs` (import tracking)

### Billing (internal tier model; Stripe integration not present yet)
- `billing_tiers`
- `billing_accounts`
- `billing_account_events`

### Anya (assistant persistence)
- `anya_sessions`
- `anya_messages`
- `anya_tasks`

## “Anya”, “geo crawl”, and “document parser” entrypoints

### Anya
- API: `backend/routes/anya.js`
- Persistence: `anya_sessions`, `anya_messages`, `anya_tasks`
- Tool registry: `backend/services/anyaToolRegistry.js`
- Orchestrator: `backend/services/anyaOrchestrator.js`

### Document parser / ingestion
- API enqueue: `POST /api/documents/ingest`
- Worker: `backend/services/documentIngestion.js` via `crawlerDispatcher.js`
- Output: updates `documents.ai_summary`, `documents.ai_sections`, and merges extracted fields into `profile_sections`

### Geo crawl
- **Not implemented as a real crawl** yet.
- Current “nationwide crawl” in `backend/services/comprehensiveCrawler.js` generates placeholder opportunities from templates and example URLs, not verified real sources.

## Frontend route/page inventory (major pages + critical actions)

Pages in `src/pages/*` include (non-exhaustive highlights):

- `Dashboard.jsx`
  - **CTA**: “Discover Grants” (navigates to `DiscoverGrants`)
  - **CTA**: “View Automations” (navigates to `Automation`)
  - **Anya chat** mounted via `AnyaChat`

- `FundingOpportunities.jsx` (aka “Funding Opportunities” / catalog)
  - **Filters**: search, source, state, profile match scoring, compliance mode, national-only
  - **Critical button**: “Trigger crawler sweep” (queues `comprehensive` crawler job)
  - **Critical invariant**: renders “Showing X opportunities” based on API `total`

- `Automation.jsx`
  - **Quick actions**: queue crawler jobs (`local`, `scholarship`, `comprehensive`, `profile_enrichment`, `item_search`)
  - **Inspect/retry/cancel**: interacts with `/api/crawlers/*`
  - **Pipeline automation panel**: interacts with `/api/grants/automation/*`

- `Login.jsx` + `AuthCallback.jsx`
  - Multi-channel login UX; OAuth callback handling

Other key workflow pages:
- `Documents.jsx` (document upload/ingest flows)
- `Organizations.jsx` / `OrganizationProfile.jsx`
- `Pipeline.jsx`, `GrantDetail.jsx`, `Calendar.jsx`, `Budgets.jsx`

## Known architectural gaps (tracked by the hardening mission)

- No CI test suite currently wired (root `npm test` only runs lint+build).
- Geo crawl is placeholder; no table for per-ZIP verified real sources.
- Stripe integration not present yet (no routes/tables/webhook handler).
- API boundary validation is inconsistent across routes (some do minimal validation).
- Observability (structured logs, request IDs, metrics) is minimal/inconsistent.

