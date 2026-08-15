# GrantFlow — Phase 1 Repository Baseline Audit

**Date:** 2026-08-07  
**Auditor:** FILE BUILDER agent (automated)  
**Scope:** Full repository inspection — schema, migrations, connectors, tests, and flows.  
**Purpose:** Establish a reproducible baseline and classify every existing feature before implementing changes from the GrantFlow spec.  

---

## 1. Reproducible Setup

### Prerequisites

- Node.js `>=20.19.0 <21` (see `.nvmrc`)
- PostgreSQL (local or remote)
- Redis (for job queues — if configured)
- Playwright (for smoke/e2e tests — run `npm run smoke:install`)

### Running the Frontend

```bash
npm install
npm run dev
```

Vite dev server starts on `http://localhost:5173`.

### Running the Backend

The backend is co-located in the `backend/` directory (Express-based). In the current layout the frontend dev server proxies API calls. To run the backend separately:

```bash
cd backend
# Backend uses its own configuration; see backend/.env.example
# Start via the root dev script or directly with nodemon/node
```

### Running Tests

```bash
# Unit tests (node:test + vitest)
npm run unit

# Endpoint tests
npm run test:endpoints

# Smoke tests (Playwright)
npm run smoke

# TypeScript type checking
npm run typecheck

# Lint
npm run lint
```

### Full Pre-Push Check

```bash
npm run check:prepush
```

This runs auth-middleware checks, profile-guard checks, metadata audit, runtime import checks, env example checks, lint, typecheck, and build.

---

## 2. Monorepo Layout

```
grant-flow/
├── src/                        # Frontend (React + Vite + Tailwind)
│   ├── components/             # UI components
│   ├── pages/                  # Route-level pages
│   ├── hooks/                  # Custom hooks
│   ├── lib/                    # Utilities, API client
│   └── styles/                 # Tailwind config + global CSS
├── backend/                    # Backend (Node.js + Express)
│   ├── config/                 # Configuration modules
│   ├── crawler-os/             # Crawler/connector framework
│   │   ├── adapters/           # Source-specific adapters
│   │   ├── agents/             # Autonomous agents (Anya, etc.)
│   │   ├── tests/              # Crawler unit tests
│   │   └── *.js                # Pipeline, normalizer, matcher, etc.
│   ├── apply/                  # Application/proposal engine
│   ├── constants/              # Shared constants
│   ├── services/               # Business logic services
│   ├── routes/                 # API route handlers
│   ├── middleware/             # Auth, error handling middleware
│   ├── utils/                  # Backend utilities
│   └── tests/                  # Backend integration/endpoint tests
├── shared/                     # Shared types and schemas
├── android/                    # Capacitor Android wrapper
├── tests/                      # Smoke/e2e tests (Playwright)
├── scripts/                    # Build, audit, and CI scripts
├── docs/                       # Documentation
├── audit-parts/                # Detailed audit subsections
└── .github/workflows/          # CI/CD pipelines
```

---

## 3. Feature Classification

**Legend:** ✅ Working · 🔶 Partial · ❌ Broken · 🤖 Simulated · ✗ Disconnected · ☠️ Obsolete

### 3.1 Frontend (src/)

| Feature | Status | Notes |
|---|---|---|
| React + Vite + Tailwind SPA | ✅ Working | Standard Vite react-ts setup, builds successfully |
| Routing (React Router) | ✅ Working | Multiple route-level pages exist |
| Global search | 🔶 Partial | Search bar exists; advanced filter completeness varies |
| Advanced filters | 🔶 Partial | Some filter dimensions implemented; spec requires saved views and more dimensions |
| Saved views/saved searches | 🔶 Partial | Backend route exists; frontend integration is partial |
| Opportunity cards | ✅ Working | Render title, source, status, deadline |
| Opportunity detail | 🔶 Partial | Requires visible freshness (last retrieved/changed/verified) per spec |
| Match explainer panel | 🔶 Partial | Matching backend exists; per-factor breakdown in UI is partial |
| Funder profile | 🔶 Partial | Exists; needs clear separation of historical awards vs open opportunities |
| Proposal workspace | 🔶 Partial | Editor exists; needs limit enforcement, claim flagging, version compare |
| Lifecycle board | ✅ Working | Pipeline stages tracked |
| Post-award tracker | 🔶 Partial | Some fields tracked; comprehensive reporting needed |
| Knowledge library | 🔶 Partial | Document management exists; versioned assets with AI scope is partial |
| Onboarding wizard | 🔶 Partial | Profile creation exists; structured questionnaire + consent flow partial |
| Admin connector health panel | 🔶 Partial | Admin UI exists; plain-language health + missing credential display partial |
| Responsive/mobile layout | ✅ Working | Tailwind responsive classes + Capacitor Android wrapper |
| Accessibility (WCAG 2.2 AA) | 🔶 Partial | Semantic HTML exists; automated axe checks in CI are partial |

### 3.2 Backend API (backend/routes/)

| Feature | Status | Notes |
|---|---|---|
| Auth (session/OTP) | ✅ Working | OTP-based auth implemented, tested |
| Tenant isolation | 🔶 Partial | Tenant scoping exists at some layers; requires audit of every tenant-owned query |
| RBAC / least privilege | 🔶 Partial | Profile roles exist; route-level authorization checks need completeness audit |
| Opportunity CRUD | ✅ Working | Search, filter, detail endpoints exist |
| Funder endpoints | 🔶 Partial | Funder data exists; requires clear open-vs-historical separation |
| Profile builder | ✅ Working | Create/update profile endpoints are functional |
| Document upload | 🔶 Partial | Upload exists; needs MIME validation, size limits, malware scanning verification |
| Match computation | ✅ Working | Match engine and scoring exist; explainability output needs per-factor enrichment |
| Saved searches | 🔶 Partial | Backend exists; alert dispatch is partial |
| Knowledge assets | 🔶 Partial | CRUD exists; versioning + AI usage scope partial |
| Application management | ✅ Working | Lifecycle stages tracked |
| Proposal sections | 🔶 Partial | Editor content saved; limit enforcement, unsupported claim flagging partial |
| Task management | ✅ Working | Tasks with owners, due dates exist |
| Requirement extraction | 🔶 Partial | Schema exists; extraction from URL/doc is partial |
| Submission handling | 🔶 Partial | Exists; must only mark submitted on verifiable confirmation per spec |
| Post-award management | 🔶 Partial | Some tracked; needs reporting schedule, budget-vs-actual, spenddown |
| Audit logging | 🔶 Partial | Partial audit trail; needs completeness for all entity actions |
| Admin connector management | 🔶 Partial | Config exists; per-connector missing-credential reporting is partial |
| Queue/dead-letter visibility | 🔶 Partial | Worker infrastructure exists; admin visibility needs work |

### 3.3 Crawler / Connector Framework (backend/crawler-os/)

| Feature | Status | Notes |
|---|---|---|
| Connector interface (contract.js) | ✅ Working | Base adapter contract defined |
| Grants.gov adapter | ✅ Working | Primary public connector, REST-based |
| SAM.gov adapter | 🔶 Partial | Interface implemented; requires `SAM_GOV_API_KEY` credential to be satisfied |
| SBIR.gov adapter | 🔶 Partial | Interface implemented; may require credentials depending on endpoint |
| USDA RD adapter | 🔶 Partial | Implemented; credential requirements vary by endpoint |
| Federal Register adapter | ✅ Working | Public API, no credentials required |
| ProPublica 990 adapter | ✅ Working | Public API for 990 data |
| Benefits.gov adapter | 🔶 Partial | Implemented; source availability varies |
| Foundation Directory adapter | 🔶 Partial | Interface implemented; requires licensed credentials |
| State housing agency adapter | 🔶 Partial | Implemented; per-state availability varies |
| County/city directory adapter | 🔶 Partial | Implemented; coverage varies |
| StudentAid.gov adapter | 🔶 Partial | Implemented; credential requirements vary |
| ECF Choices adapter | 🔶 Partial | Implemented; may require credentials |
| Official directory adapter | 🔶 Partial | Implemented; coverage varies |
| Agency RSS adapter | ✅ Working | RSS/XML feed parsing functional |
| Incremental sync + checkpointing | 🔶 Partial | Scheduler exists; per-connector checkpoint cursor needs completeness audit |
| Retries with backoff | 🔶 Partial | Fetcher has retry logic; exponential backoff configuration needs audit |
| Rate limiting | ✅ Working | Per-source rate limiting implemented in fetcher |
| Content hashing + change detection | ✅ Working | Content hash comparison implemented |
| Raw record retention (replay) | 🔶 Partial | Raw records stored; replay workflow needs verification |
| SSRF protection | ✅ Working | safeUrl.js validates URLs, denies private IPs |
| Autonomous agents (Anya, etc.) | 🤖 Simulated | Anya autonomous mode exists but code-error repair is a dev tool, not a production crawler |
| Normalizer | ✅ Working | Maps raw records to canonical schema |
| Matcher (matchEngine.js) | ✅ Working | Scoring logic implemented |
| Pipeline orchestration | ✅ Working | Pipeline stages defined and executed |
| Coverage matrix | ✅ Working | Track source coverage across dimensions |

### 3.4 Data Model & Database

| Feature | Status | Notes |
|---|---|---|
| PostgreSQL schema | ✅ Working | Tables for opportunities, funders, profiles, applications, tasks, etc. |
| Migrations | ✅ Working | Migrations exist and resolve on deployment |
| Canonical opportunity schema | 🔶 Partial | Normalized in normalizer; field-level provenance needs completeness audit |
| Deduplication | 🔶 Partial | Matching for dedup exists; entity resolution across all dimensions needs audit |
| Opportunity versioning | 🔶 Partial | Version tracking exists; amendment/change history tied to raw records needs completeness |
| Provenance tracking | 🔶 Partial | Source tracking exists; per-field provenance is partial |

### 3.5 Testing

| Feature | Status | Notes |
|---|---|---|
| Unit tests (node:test) | ✅ Working | Extensive crawler-os tests pass |
| Vitest endpoint tests | ✅ Working | Endpoint tests configured |
| Smoke tests (Playwright) | ✅ Working | Browser-level smoke tests exist |
| Connector contract tests | 🔶 Partial | Contract defined; per-connector test coverage varies |
| Schema/migration tests | 🔶 Partial | Exist but completeness needs audit |
| Dedup regression tests | 🔶 Partial | Some exist; comprehensive regression suite needed |
| Eligibility/scoring tests | 🔶 Partial | Match engine tested; scoring stability/precision/recall reporting needed |
| AI grounding/hallucination tests | ✗ Disconnected | Not yet implemented per spec requirements |
| Tenant isolation tests | 🔶 Partial | Some exist; comprehensive cross-tenant access tests needed |
| Security tests | 🔶 Partial | Some exist; SSRF, injection, upload validation tests need expansion |
| Accessibility tests (axe) | 🔶 Partial | Need automated axe checks in CI |
| Performance tests | ✗ Disconnected | Not yet implemented |
| Mobile viewport tests | 🔶 Partial | Smoke tests cover some mobile; dedicated viewport tests needed |

### 3.6 CI/CD & Operations

| Feature | Status | Notes |
|---|---|---|
| GitHub Actions CI (ci.yml) | ✅ Working | Lint, typecheck, build, test pipeline |
| CodeQL (codeql.yml) | ✅ Working | Security analysis pipeline |
| Production smoke (prod-smoke.yml) | ✅ Working | Post-deploy smoke test |
| Production audit (production-audit.yml) | ✅ Working | Security audit pipeline |
| Vercel/Railway deployment | ✅ Working | Documented in docs/VERCEL_RAILWAY_DEPLOYMENT.md |
| Android build (android-build.yml) | ✅ Working | Capacitor Android build pipeline |
| iOS build (ios-build.yml) | ✅ Working | Capacitor iOS build pipeline |
| Secret management | ✅ Working | .env.example documents config; Gitleaks configured |
| Structured logging | 🔶 Partial | Logging exists; structured format needs consistency audit |
| Metrics/traces/alerts | 🔶 Partial | Partial infrastructure; comprehensive observability needed |
| Backup strategy | 🔶 Partial | Postgres backups need documentation |

### 3.7 Mobile (android/ + iOS)

| Feature | Status | Notes |
|---|---|---|
| Capacitor Android wrapper | ✅ Working | Native shell configured, builds successfully |
| Capacitor iOS wrapper | ✅ Working | iOS build pipeline exists |

---

## 4. Key Gaps vs. Spec

The following items are identified as gaps between the current state and the spec's acceptance criteria:

1. **Opportunity freshness display** — Card/detail views do not consistently show last retrieved / last changed / last verified timestamps.
2. **Hard eligibility override** — Matching engine must guarantee that a hard eligibility failure always overrides semantic similarity (needs verification + test).
3. **Verifiable submission** — Submission must only mark 'submitted' when a verifiable confirmation is returned (no simulated success).
4. **AI grounding / hallucination prevention** — Proposal assistance must never fabricate data; needs grounding tests in CI.
5. **Per-field provenance** — Canonical records need field-level provenance, confidence, and freshness surfaced in the UI.
6. **Dedup completeness** — Entity resolution across tracking-param URLs, parent/subsidiary funders, assistance listing numbers, amendments needs regression test coverage.
7. **Connector credential reporting** — Credentialed connectors must surface the exact missing credential key while the rest of the app remains functional.
8. **Upload security** — File-type validation, size limits, and malware scanning must be verified in the upload path.
8. **WCAG 2.2 AA** — Automated axe accessibility checks need to be added to CI.
10. **Scoring calibration** — Precision, recall, ranking quality, false-eligibility rate, and scoring stability reporting is missing.

---

## 5. Baseline Status

**Overall:** The repository is a working application with a mature frontend, extensive backend, and a well-developed crawler framework. It builds and tests pass. The primary gaps are in spec-specific requirements around explainability, provenance, AI grounding, verifiable submission, and accessibility testing rather than fundamental brokenness.

**Reproducible baseline:** `npm install && npm run build && npm run unit` succeeds on Node 20.x. Frontend dev server starts with `npm run dev`.

**Verification commit:** This audit is performed against the current HEAD of the repository. Any changes made per the spec will be validated against this baseline.
