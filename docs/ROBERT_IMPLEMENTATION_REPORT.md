# Robert — Implementation Report

This report documents the initial implementation of Robert, GrantFlow's
Funding Discovery Agent.

## Scope

- New background agent named **Robert**.
- Discovers + verifies funding opportunities, delegates ingestion +
  matching to canonical services, queues per-profile recommendations,
  and never auto-adds anything to a user's pipeline.
- Disabled by default; observe-mode safe; no live web access without
  explicit env flag.

## Files added

### Backend services
```
backend/services/robert/robertTypes.js
backend/services/robert/robertSafety.js
backend/services/robert/robertRunStore.js
backend/services/robert/robertSourceRegistry.js
backend/services/robert/robertProfileDemandPlanner.js
backend/services/robert/robertSearchPlanner.js
backend/services/robert/robertCoverageAnalyzer.js
backend/services/robert/robertSourceDiscovery.js
backend/services/robert/robertOpportunityExtractor.js
backend/services/robert/robertOpportunityNormalizer.js
backend/services/robert/robertVerification.js
backend/services/robert/robertIngestionBridge.js
backend/services/robert/robertMatchBridge.js
backend/services/robert/robertRecommendationService.js
backend/services/robert/robertRecommendationDelivery.js
backend/services/robert/robertAgent.js
backend/services/robert/robertScheduler.js
```

### Backend routes
```
backend/routes/robert.js
```

### Migrations
```
backend/db/migrations/081_robert_tables.sql               (SQLite)
backend/db/postgres/migrations/0077_robert_tables.sql     (Postgres)
backend/db/schema.sql                                     (idempotent CREATE TABLEs added)
```

### Frontend
```
src/components/robert/RobertRecommendationListener.jsx
src/components/robert/RobertRecommendationDetailsModal.jsx
src/components/admin/AdminRobertConsole.jsx
```

### Tests
```
tests/unit/robert-test-helpers.mjs                  (in-memory DB shim)
tests/unit/robert-safety.test.mjs
tests/unit/robert-source-registry.test.mjs
tests/unit/robert-search-planner.test.mjs
tests/unit/robert-opportunity-normalizer.test.mjs
tests/unit/robert-verification.test.mjs
tests/unit/robert-ingestion-bridge.test.mjs
tests/unit/robert-match-bridge.test.mjs
tests/unit/robert-recommendation-service.test.mjs
tests/unit/robert-recommendation-delivery.test.mjs
tests/unit/robert-coverage-analyzer.test.mjs
tests/unit/robert-agent.test.mjs
```

### Documentation
```
docs/ROBERT_FUNDING_DISCOVERY_AGENT.md
docs/ROBERT_SOURCE_STRATEGY.md
docs/ROBERT_IMPLEMENTATION_REPORT.md
```

## Files changed

```
backend/server.js          — mount /api/robert router; start Robert scheduler on listening
src/pages/Layout.jsx       — mount <RobertRecommendationListener />
src/pages/Admin.jsx        — add "Robert" admin tab
backend/db/schema.sql      — add robert_* tables
```

## Endpoints added

Public:
- `GET /api/robert/health`

Admin-only:
- `GET /api/robert/status`
- `POST /api/robert/run`
- `POST /api/robert/analyze-coverage`
- `POST /api/robert/discover-sources`
- `POST /api/robert/discover-opportunities`
- `POST /api/robert/verify-candidates`
- `POST /api/robert/ingest-verified`
- `POST /api/robert/match-new`
- `POST /api/robert/recommend`
- `GET /api/robert/runs`
- `GET /api/robert/runs/:runId`
- `GET /api/robert/source-candidates`
- `POST /api/robert/source-candidates/:id/approve`
- `POST /api/robert/source-candidates/:id/reject`
- `GET /api/robert/opportunity-candidates`
- `POST /api/robert/opportunity-candidates/:id/approve-ingest`
- `POST /api/robert/opportunity-candidates/:id/reject`

Authenticated profile-scoped (uses `ensureProfileAccess`):
- `GET /api/robert/recommendations`
- `GET /api/robert/recommendations/deliverable`
- `GET /api/robert/recommendations/stream`
- `GET /api/robert/recommendations/:id`
- `POST /api/robert/recommendations/:id/accept`
- `POST /api/robert/recommendations/:id/decline`
- `POST /api/robert/recommendations/:id/viewed`
- `POST /api/robert/recommendations/:id/dismiss`
- `POST /api/robert/recommendations/:id/delivered`

## Environment variables added

See [`docs/ROBERT_FUNDING_DISCOVERY_AGENT.md`](./ROBERT_FUNDING_DISCOVERY_AGENT.md#environment-variables).
All defaults are the safest possible (Robert disabled, observe mode,
no live web, no auto-ingest, polling only).

## Tests added

12 unit-test files / **69 assertions** across:

| File | Acceptance criteria covered |
|---|---|
| `robert-safety.test.mjs` | (1) disabled-by-default, (4) rejects placeholder URLs, (8) rejects search-engine URLs, (5) rejects loans, (6) rejects matching funds, (7) rejects expired deadlines, (19) masks secrets in logs |
| `robert-source-registry.test.mjs` | seed registry contains real .gov sources only, trust scoring rejects placeholders, source-type classification |
| `robert-search-planner.test.mjs` | geographic expansion city → county → state → national (16), excludes loans/matching funds in queries, query strings never contain placeholders |
| `robert-opportunity-normalizer.test.mjs` | rejects placeholder URLs (4), rejects search-engine URLs (8), produces canonical `record_origin: 'discovered'` shape |
| `robert-verification.test.mjs` | (4)(5)(6)(7)(8) preflight rejects, dead-link rejection only with live web on (40), no live calls when live web off (2) |
| `robert-ingestion-bridge.test.mjs` | (10) uses canonical opportunityPolicy, (11) uses canonical ingestion, never bypasses gates |
| `robert-match-bridge.test.mjs` | (12) uses canonical computeMatchDecision, gracefully handles missing profile context |
| `robert-recommendation-service.test.mjs` | (21) creates pending recs only when helpful, (22) does not auto-add, (26) refuses duplicates, (27) recs do not leak across profiles, (29) view marks viewed without acceptance, (30) declined recs are not re-shown, (32) low-confidence matches do not toast, (33) high-confidence ones produce explainable reasons, (34) declined → general pool only |
| `robert-recommendation-delivery.test.mjs` | (28) toast queue shows only pending recs for active profile, (35) live delivery, (36) login delivery, (38) recovers missed events, (40) polling fallback |
| `robert-coverage-analyzer.test.mjs` | (16) zero-result-profile broadening without showing junk, recommended search queries, broader geography |
| `robert-agent.test.mjs` | (1) disabled-by-default, (2) observe does not crawl internet, (3) does not ingest unverified, (13) respects max profiles per run, (4) rejects placeholder URLs end-to-end, run-history persistence, status reporting |
| `robert-test-helpers.mjs` | (in-memory shim used by every DB-backed test) |

Other acceptance criteria are enforced by the implementation but are
verified end-to-end by integration with canonical services rather than
Robert-specific unit tests:

- (9) Stores rejected candidates with reasons → `robert_opportunity_candidates.verification_reasons_json`.
- (14) Domain rate limiting → `robert_domain_rate_limits` + `checkRateLimit`.
- (15) Avoids overlapping scheduled runs → `_running` lock in `robertScheduler.js`.
- (17) Admin endpoints require admin → `adminOnly` middleware in `backend/routes/robert.js`.
- (18) Health endpoint does not expose secrets → `/health` returns only `{ ok, agent, status }`.
- (20) SQLite + Postgres parity → both migrations idempotent + schema.sql.
- (23) Accepting a recommendation adds to the correct pipeline → `accept` route calls canonical `saveToProfilePipeline`.
- (24) Declining keeps the opportunity in the general pool → no opportunity write happens on decline.
- (25) Opportunities with no matching profile → general pool only (Robert never creates a recommendation if no profile fits).
- (31) Accepted recommendations refresh pipeline data → frontend toast onAccept refreshes data via apiFetch.
- (37) Listener closes stream/polling on logout → `useEffect` cleanup in `RobertRecommendationListener`.
- (39) Daily toast caps → `ROBERT_MAX_TOASTS_PER_PROFILE_PER_DAY` enforced in `selectDeliverable`.

## Commands run

| Command | Result |
|---|---|
| `npm run -s lint:strict` | exit 0, no findings |
| `npm run -s typecheck` | exit 0, no errors |
| `npm run -s build` | built `dist/` successfully |
| `node --test tests/unit/robert-*.test.mjs` | **69 / 69 passed**, 0 failed |
| `npm run -s unit` | **712 / 712 tests** across 255 files passed |
| `npm run -s crawler:doctor` | OK |

## Known limitations

1. **No default `searchProvider` shipped.** Robert ships with an
   adapter-based discovery layer but no built-in search engine. To
   enable real source discovery in production you must inject your own
   `searchProvider` (e.g. SerpAPI, Bing Web Search, internal search
   index). The unit tests cover this with a fake provider.
2. **No default `opportunityAdapter` shipped.** Same pattern — Robert
   accepts source-specific adapters (Grants.gov API, Benefits.gov,
   foundation HTML you've already parsed) instead of attempting to be
   a generic HTML scraper. This keeps the production surface auditable
   and the test suite deterministic.
3. **Polling instead of SSE.** GrantFlow does not currently have an
   SSE/WebSocket infrastructure; Robert exposes
   `/api/robert/recommendations/stream` as a `since`-aware polling
   endpoint with a server-suggested cadence. The frontend listener is
   already structured to swap in SSE in a follow-up if needed.
4. **Coverage learning is single-pass.** Per-source acceptance/decline
   rate aggregation is not yet rolled into the coverage analyzer; only
   the raw data is persisted. A subsequent change can layer this in.
5. **Delivery `delivered_on_login` is set explicitly.** The login
   delivery path is exposed via `POST /api/robert/recommendations/:id/delivered`
   with `via: 'login'` — this enables the frontend to choose the right
   transport label. The agent does not yet auto-promote QUEUED recs to
   `delivered_on_login` on a user's first authenticated request; that's
   a small future enhancement.

## Next improvements

- Default search adapters for Grants.gov + Benefits.gov + FEMA AFG/SAFER.
- Per-source acceptance learning loop into `robert_profile_coverage`.
- Optional SSE transport when GrantFlow grows SSE infrastructure.
- Admin UI for source-candidate review (list with accept/reject buttons).
- A "Robert health card" alongside Sam's in the production dashboard
  so an operator can see the discovery agent at a glance.

## Rollback plan

Robert is **disabled by default** and gated behind `ROBERT_ENABLED`,
`ROBERT_ALLOW_LIVE_WEB`, and `ROBERT_AUTO_INGEST_VERIFIED`. To roll back
in production:

1. `ROBERT_ENABLED=false` (immediate stop, no scheduler runs).
2. Optional: `ROBERT_RECOMMENDATION_TOASTS_ENABLED=false` to silence
   already-queued recs.
3. The router stays mounted but only `/api/robert/health` returns
   non-empty data.

If a full revert is needed, drop the migration tables (or simply leave
them — they are inert when the agent is disabled).
