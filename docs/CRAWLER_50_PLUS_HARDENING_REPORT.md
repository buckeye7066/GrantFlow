# Crawler 50+ Hardening — Progress Report

Branch: `fix/crawler-system-50-plus-mission-hardening`. Started 2026-06-22.

**This is an honest, phased report. It does NOT claim the full mission is complete.**
Increment 1 (this commit) delivers the mandated system map + the two highest-leverage,
test-proven root fixes. Remaining root fixes (A–L) are scoped below as follow-ups; none
are faked or stubbed.

## Done in increment 1

### Inventory (mandated first deliverable)
- `docs/CRAWLER_SYSTEM_INVENTORY.md` — real map from a read-only sweep: 29 strategy
  crawler types, 26 job types, ~78 sourceRegistry SOURCE_IDs, 13 crawlers + 8 domain
  engines + 5 source adapters, National Crawler V2 (4 smoke + bridge-to-catalog),
  routes, crawler tables/migrations, and the verification coverage gap (6–8 of 29 tested).

### Root fix C — multi-source orchestration (was a real bug)
- `crawlerFramework.runFullCrawl` previously forwarded only `sources[0]` as the
  crawlerType, silently dropping every other requested crawler. Fixed: it now runs
  EVERY requested crawler_type, de-dups aggregated results by URL, isolates per-source
  failures (one failing type no longer wipes the run), and returns honest telemetry
  (`source_outcomes`, `partial`, `failed_types`, `crawler_types_run`).

### Root fix B/L — county geo-stub source (the junk generator)
- `countyFundingCrawler` synthesized one fake "United Way of {County} County" /
  "Community Action Agency - {County} County" "program" per county whose
  `application_url` was a NATIONAL locator page — dishonest geo-stubs that flooded
  pipelines (1,366 such rows were just purged from prod). Fixed:
  - Gated OFF by default (`COUNTY_FUNDING_CRAWLER_ENABLED`, opt-in only).
  - When enabled, emits HONEST DIRECTORY resources: `opportunity_kind='DIRECTORY'`,
    `record_type='directory_resource'`, `application_url=null`, real locator kept as
    `source_url`, and "Find your local <resource> — <County> County, <ST>" titles —
    never fake county-specific direct opportunities. (Policy treats these as honest
    directories; they can no longer masquerade as direct grants.)

### Tests (proving the above)
- `tests/unit/county-crawler-honest-directory.test.mjs` (new) — gate-off-by-default,
  short-circuit before DB, every org pattern has an honest `resourceLabel` + real https
  locator. PASS (2/2).
- Existing crawler suites still green: `crawler-policy-proof`, `real-crawlers-policy`,
  `real-crawlers-local-funding`, `golden-crawlers`, `crawler.contract` → 63/63 PASS.
- `npm run lint` 0 errors, `npm run typecheck` clean, `npm run build` ✓.

### Related (separate commits, already on main + prod)
- Sticky cleanup of 1,366 geo-stub rows from prod pipelines via `recordDismissal` +
  `reconcileDismissedGrants` (won't resurface). demo_senior_family 237→11, Vermilion 112→60.

## Remaining mission scope (NOT done — follow-up increments)

These are real, planned, and intentionally not faked:
- **A. Unify crawler contract** — single `crawlerContract.js` normalize-through point.
- **B (full). Universal policy wrapper** — route EVERY emit/store path through one
  `enforceOpportunityPolicy` wrapper with rejection counts; audit the remaining bypasses
  (V2 store, some source adapters) beyond the county fix landed here.
- **D. crawlerPlanner** — connect sourceRegistry (78) ↔ strategyRegistry (29) with a
  coverage plan (planned/queried/failed/found/stored/rejected + why-not).
- **E. Verification overhaul** — dynamic-discovery harness covering ALL 29 types + 78
  sources + domain engines + V2 + Geo, emitting `test-results/crawler-system-report.{json,md}`.
  (Current scripts test only 6–8; this is the biggest remaining gap.)
- **F. 25 golden profile fixtures** + assertions (real-URL rate, match_explain rate,
  loan/match exclusion, isolation, slider, committed-student behavior, ECF exception,
  zero-result explanations).
- **G. Single SSRF-safe URL validator** applied before fetch/HEAD/store/persist/response.
- **H. storeResults atomicity** — wrap delete+insert in a transaction; keep prior run
  until the new run completes.
- **I. V2 promotion test** — policy-gated `bridgeProgramToCatalog`, TRACK_A/B separation.
- **J/K. Admin health + response contract** — surface all 50+ sources, stale/failed,
  and the full `debug.*` response envelope on crawler routes.
- Scoring-engine consolidation (matchingEngine vs crawlerHelpers) and comprehensive
  cross-crawler dedup (docs/CRAWLER_ANALYSIS.md #1/#2).

## Needs live credentials / running server (SKIPPED here, with commands)
- `node scripts/verify-crawlers-prod.mjs --base-url <url> --profile-id <id>` — needs a
  running server + admin context. SKIPPED (no headless admin token).
- Real profile-keyword web discovery (the long-term fix for geo-stub reliance) needs
  `BRAVE_SEARCH_API_KEY` to wire the Brave searchProvider + LLM opportunityAdapter.
- Prod end-to-end crawl verification runs against Railway (internal DB) via `railway ssh`.

## Files changed (increment 1)
- `backend/services/crawlerFramework.js` (multi-source orchestration)
- `backend/services/countyFundingCrawler.js` (gate + honest directory shape)
- `docs/CRAWLER_SYSTEM_INVENTORY.md` (new)
- `docs/CRAWLER_50_PLUS_HARDENING_REPORT.md` (new, this file)
- `tests/unit/county-crawler-honest-directory.test.mjs` (new)
