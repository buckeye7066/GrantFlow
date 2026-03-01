# GrantFlow Canonical Rules & Goals

_Last updated: 2026-01-28_

This document is the **single source of truth** for GrantFlow’s product rules, correctness invariants, and acceptance criteria.

If a rule is uncertain, it is marked explicitly as an **Assumption**. **Do not change behavior** that depends on an assumption until the assumption is either confirmed or replaced with an explicit rule.

## Scope

Applies to:
- **Backend**: `backend/server.js`, `backend/routes/*`, `backend/services/*`, SQLite schema in `backend/db/schema.sql`
- **Frontend**: `src/pages/*`, `src/api/*`, `src/stores/*`
- **Automation**: crawler jobs (`crawler_jobs`), funding catalog (`funding_opportunities`), pipeline (`grants`)

## Definitions

- **Profile**: A record in `profiles` plus its structured `profile_sections`. Profiles may be linked to a user via `profiles.user_id`.
- **Opportunity / Funding Opportunity**: A row in `funding_opportunities` (the “Discover Grants / Funding Opportunities catalog”).
- **Grant**: A row in `grants` representing a pursued opportunity (pipeline status workflow).
- **Crawler Job**: A row in `crawler_jobs` representing an automation run (local, scholarship, comprehensive, item_search, document_ingest, profile_enrichment, pipeline_automation, avatar_lookup).
- **Match score**: A normalized score in \([0,1]\) for standardized crawler output (future) and a UI match score in \([0,100]\) for display. Conversion: \(score\_{pct} = round(score\_{0..1} * 100)\).
- **Orphan profile**: A `profiles` record that is **not linked to any `users` row** (`profiles.user_id IS NULL`) but is otherwise active.

## Product goals (from repo docs + implementation)

Sources:
- `README.md`
- `docs/PROD_READINESS.md`
- `docs/AUTH_FLOW_BLUEPRINT.md`
- `docs/BASE44_GAP_ANALYSIS.md`
- `OPS_AUTOFIX.md`
- Current implementation in `backend/services/*.js` and `src/pages/*.jsx`

### G1. Non-fragile, observable, and testable

- **No silent failures**: exceptions must be surfaced to the caller (API response / job status) with context.
- **Every critical behavior has a test**: unit/integration/E2E coverage is required for core flows.
- **Deterministic automation**: given identical inputs, mocked externals, and the same DB seed, automation results must be stable in CI.

### G2. Funding discovery must be useful (zero-results is a failure state)

This repo’s UX and automation pages present crawlers as a system that should populate the opportunity catalog.

Hard rule:
- **Zero results is a failure state** for discovery operations. If an operation evaluates candidates but includes none, the system must **log why items were removed** and then **relax constraints and/or re-score** rather than returning a silent empty set.

### G3. Crawl results must appear in the “Discover Grants / Funding Opportunities” UI

Hard rule:
- If crawlers insert opportunities into `funding_opportunities`, those opportunities **must be retrievable** via `GET /api/opportunities` and **must be count-visible** in the UI.

Hard rule (counts mapping):
- The UI’s “Showing X opportunities” must map **1:1** to backend response fields:
  - `GET /api/opportunities` returns `{ data, total, limit, offset }`
  - UI displays `total` when provided, otherwise `data.length`

### G4. Profile-driven behavior (avoid brittle boolean filtering)

Hard rules:
- **Missing profile fields must not disqualify** a funding source by default. Missing fields are neutral.
- **Profile attributes increase score, not eliminate results** by default.
- **Exact-match requirements are forbidden** unless legally required.
- **Population/eligibility mismatches reduce score, not discard results** (unless the opportunity is explicitly exclusive).
- **Hard AND filters must be avoided** unless the funding source is explicitly exclusive.

Geographic matching rule:
- Matching expands outward: **city → county → state → national** (never only “exact ZIP” unless explicitly exclusive).

Directory-style resources rule:
- Directory-style or general funding resources (broad “where to find grants” sources) must survive filtering unless explicitly excluded.

### G5. Compliance (“grant funds only”) is a presentation/triage layer, not data loss

Current code supports a “Funding terms” filter in UI (`src/pages/FundingOpportunities.jsx`) backed by `GET /api/opportunities?compliance=...`.

Hard rules:
- Compliance classification must be **computed and explainable** (`compliance_status`, `compliance_reasons`), never silently applied.
- **Default behavior must not hide all opportunities**. If applying compliance filtering would produce zero results while opportunities exist, the response must include:
  - a reason summary explaining removals, and/or
  - a relaxed mode suggestion (or automatic fallback) that still returns some opportunities.

Assumption (pending confirmation):
- “Grant funds only” is the default view, but “review-required” opportunities should remain available via a filter toggle without being deleted/ignored in storage.

### G6. Automation job invariants

Hard rules:
- Every `crawler_jobs` run must end in one of: `completed`, `failed`, `cancelled`.
- A completed job must store:
  - `result_count` (inserted or processed count)
  - `result_meta` (JSON) with at least `duration_seconds` and relevant counters (e.g., `evaluated`, `inserted`)
- Failures must store a non-empty `error` and should store a structured `result_meta.error`.

### G7. Geo crawler (nationwide ZIP coverage) must persist REAL sources (≥ 3 per ZIP)

The UI and docs claim “Nationwide crawl… at least three grants per ZIP” (see `src/pages/Automation.jsx` and `src/pages/FundingOpportunities.jsx`).

Hard rules:
- Maintain a durable `geo_funding_sources`-style table keyed by ZIP.
- For each ZIP, persist **≥ 3 verified sources**, or the ZIP job remains incomplete and retries later.
- “REAL” means:
  - URL is valid and non-placeholder
  - URL is reachable (polite rate limiting, timeouts)
  - The source appears to be a funding/grants entity (heuristics + allow/deny list)
  - De-duplicate by normalized domain + name
- Must respect robots.txt and terms; prefer official/public datasets or directories.
- The nationwide crawl must be **incremental and resumable** (checkpointed).

### G8. Security, RBAC, and secrets handling

Hard rules:
- Secrets live in env vars; no keys in code.
- Admin access must be enforced server-side; UI-only protection is insufficient.
- Auth/session tokens handled securely; avoid leaking across accounts.

## Known gaps / TODOs (must become hard rules once implemented)

- Standardized crawler output schema: `{ raw, normalized, score_0_1, explain, provenance }`
- Deterministic pipeline runner: every crawler × every profile, persist results with score > 0.50
- Stripe end-to-end billing contract and idempotent webhook handling

