# GrantFlow Crawler System Inventory

> Generated 2026-06-22 on branch `fix/crawler-system-50-plus-mission-hardening` from a
> read-only mapping of the live codebase. This is the factual map that the hardening
> work builds on. "Fixed in this branch" rows are updated as fixes land.

## 1. Crawler types (strategyRegistry — 29)

`backend/services/crawlers/strategyRegistry.js`. Each has `candidateSources` + optional `hardGates`.

| crawler_type | scope | hard gate |
|---|---|---|
| comprehensive | global | — |
| local_funding | geo | — |
| government_funding | geo | — |
| student_grants | profile | education |
| health_resources | profile | healthcare |
| special_needs | profile | special_needs |
| ecf_benefits | profile | special_needs (eligibility exception) |
| curated_benefits | global | — |
| license_reinstatement / certification_training | profile | — |
| item_matching | profile | — |
| nonprofit_org, volunteer_fire, church, family, school, housing_funding | org-type | — |
| county_government, municipality, public_agency, tribal_government | org-type | — |
| teacher_classroom, school_district_department, library, parks_recreation, public_health_department | org-type | — |
| animal_rescue, food_pantry, homeless_services | org-type | — |

Profile gating only triggers when the profile's intents Set is non-empty AND all required hard-gates are absent → honest gated reason. (strategyRegistry.js:505–535)

## 2. Crawler job types (constants — 26)

`CRAWLER_JOB_TYPES` in `backend/config/constants.js`: anya_match_scout, avatar_lookup, clinical_trials, comprehensive, curated_benefits, document_ingest, ecf_benefits, ecf_hcbs, foundation_990, government_funding, health_resources, item_gift_search, item_matching, item_search, live_search, local, local_funding, national, national_zip_scan, pipeline_automation, portal_check, profile_enrichment, scholarship, special_needs, student_bridge_funding, student_grants. Statuses: queued|running|completed|failed|cancelled.

## 3. Source registry (sourceRegistry — ~78 SOURCE_IDs)

`backend/services/sourceRegistry.js`. Each carries trust tier, profile_types, needs, freshness_days, verification_required, directory flag. Families: federal (grants_gov, sba_grants, fema_afg, usda_rural_dev…), state (state_portal, state_county_grant_portals…), directories (cof_foundation_locator, united_way_211, feeding_america, community_action, overpass_local…), education (ed_gov_fafsa, pell_grant, scholarship_directory, student_scholarship_portals…), benefits (liheap, snap, medicaid), local-government (~13), teacher/school (~11), tribal (2), nonprofit verticals (~7).

## 4. Individual crawlers (backend/services)

| crawler | file | scope | policy enforced | synthesizes stubs | table |
|---|---|---|---|---|---|
| domainCorpusCrawler | crawlers/domainCorpusCrawler.js | profile | hasUrl + HEAD verify | no | funding_opportunities |
| domainCrawlerEngine (+ 8 domainEngines/) | crawlers/domainCrawlerEngine.js | profile | normalizeOpportunity URL gate | no | via corpus |
| itemFundingCrawler | crawlers/itemFundingCrawler.js | profile | **yes** (1019,1157) | no | funding_opportunities |
| ecfBenefitsCrawler | crawlers/ecfBenefitsCrawler.js | profile (eligibility) | isLoan + downstream | no | funding_opportunities |
| stateWaiverBenefitsCrawler | crawlers/stateWaiverBenefitsCrawler.js | profile/state | normalize + directory guard | no | funding_opportunities |
| nationalZipCrawler | crawlers/nationalZipCrawler.js | geo (ZIP) | delegated to source APIs | **removed** (legacy "near X" synthesizer gone; ~96k legacy rows persist in catalog) | funding_opportunities + geo tables |
| localCrawler | localCrawler.js | profile/geo | calculateMatchScore + floor | no | funding_opportunities |
| **countyFundingCrawler** | countyFundingCrawler.js | per-county | **NO** | **YES — "United Way of {county} County", "Food Bank - {county} County", "Community Action Agency - {county} County", etc. with national directory URLs** | funding_opportunities |
| itemCrawler / itemGiftCrawler | itemCrawler.js / itemGiftCrawler.js | profile | via itemFunding / fixture | no | funding_opportunities |
| foundation990Crawler | crawlers/foundation990Crawler.js | profile | match floor 40 | no | funding_opportunities |
| studentBridgeFundingCrawler | crawlers/studentBridgeFundingCrawler.js | profile (student) | pipeline checks | calendar templates (review) | funding_opportunities + grants |

Source adapters `backend/services/sources/`: grantsGov.js (shim), samGov.js (SAM_GOV_API_KEY), statePortals.js (OH/CA/TX only), usaSpending.js, ingestionService.js (**enforces policy at 151**).

## 5. Policy: `enforceOpportunityPolicy(opp, opts)` — opportunityPolicy.js:264

Returns `{ok, reason}`. Rejects: invalid_object, no_real_url (placeholder/invalid host), search_engine_url_for_direct_opp, placeholder_text, loan_like (with loan-forgiveness/repayment-assistance exemptions), matching_funds, expired_deadline.

**Invoked at:** itemFundingCrawler, opportunityInserter.js:354 (upsert gate), sources/ingestionService.js:151, robert/robertVerification.js:112. **Bypassed by:** countyFundingCrawler (no call), and any path not routing through opportunityInserter/ingestionService.

## 6. National Crawler V2 (`backend/services/nationalCrawlerV2/`)

Separate pipeline: registry→fetchers(SSRF-guarded)→parsers(HTML/PDF/DOCX)→normalize(TRACK_A client / TRACK_B provider split, deterministic ids)→store(`nf_programs_a`/`nf_programs_b`, `nf_program_versions`). Telemetry: crawler_sources, crawl_runs, crawl_events, parse_failures. **Promotion path EXISTS**: `bridgeProgramToCatalog()` in run.js (~375–400) bridges normalized programs into the shared catalog — so the doc claim that V2 "does not drive Discover Grants" is stale. Scope modes: SMOKE (offline fixtures) / STATE / NATIONAL. Mock URLs rejected in run.js (~279).

## 7. Routes

- `backend/routes/realCrawlers.js` — /run, /run-multiple, /specific-need (profile crawler surface).
- `backend/routes/crawlers.js` — job CRUD, idempotency key (computeIdempotencyKey 63), TYPES_REQUIRING_PROFILE guard, gateAndStampReality.
- `backend/routes/crawlerV2.js` — /health, /runs, /runs/:id, /run.
- `backend/routes/adminCrawlCoverage.js` — admin coverage/health.

## 8. Crawler tables / migrations

`crawler_jobs` (+ idempotency 005/0010, heartbeat 038/0041, snapshot+dead-letter 042/0042, worker tracking 057/0050, url fingerprint 058/0051, expanded types pg 0046), `crawler_source_runs` (072/0066 — planned/queried/failed/found/directory per source), `crawl_results`, `crawl_metadata`, `funding_opportunities`, `funding_opportunity_geo_index`, `national_zip_progress`, `geo_state_runs`, V2: `nf_programs_a/b`, `nf_program_versions`, `crawler_sources`, `crawl_runs`, `crawl_events`, `parse_failures`.

## 9. Verification scripts — COVERAGE GAP

| script | crawler types tested |
|---|---|
| scripts/run-all-real-crawlers.mjs | 6 (local_funding, government_funding, student_grants, ecf_benefits, item_matching, special_needs) |
| scripts/verify-crawlers-prod.mjs | 8 (+ comprehensive, health_resources, curated_benefits) |
| scripts/sweep-crawlers.mjs | ~8 |
| scripts/crawler-doctor.mjs | smoke (V2 SMOKE_MODE) + endpoints |
| backend/scripts/check-crawlers.mjs / dispatch-crawlers.mjs | status / manual dispatch |

29 strategy types + ~78 sources + 8 domain engines + V2 registry → **only 6–8 proven**. This is the central verification gap the mission targets.

## 10. Known defects (to fix on this branch)

| id | defect | location | status |
|---|---|---|---|
| C | `runFullCrawl` collapses `sources` → `sources[0]` (multi-source crawl drops all but first) | crawlerFramework.js:99 | **FIXED (this branch)** |
| B/L | countyFundingCrawler synthesizes geo-stubs + bypasses policy | countyFundingCrawler.js:88–138 | **FIXED (this branch — gated + policy + honest directory labeling)** |
| H | storeResults DELETE+INSERT not transactional | crawlerManager.js:660–686 | pending |
| E | verification covers 6–8 of 29 types | scripts/* | pending (dynamic-discovery harness) |
| — | two scoring engines (matchingEngine vs crawlerHelpers) | docs/CRAWLER_ANALYSIS.md #2 | pending |
| — | comprehensive lacks cross-crawler dedup | docs/CRAWLER_ANALYSIS.md #1 | pending |
| I | V2 bridge-to-catalog lacks dedicated policy-gated promotion test | nationalCrawlerV2/run.js | pending |

See `docs/CRAWLER_50_PLUS_HARDENING_REPORT.md` for the running change log + test results.
