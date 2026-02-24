# Profile Taxonomy and Facet Matching

This document describes the canonical profile taxonomy used by crawler discovery, query planning, and match scoring.

## Files

- `backend/services/profile/applicationSchema.json`
- `backend/services/profile/profileTaxonomy.js`
- `backend/services/crawlers/queryPlanner.js`
- `backend/services/crawlers/crawlerOpportunityContract.js`
- `backend/routes/realCrawlers.js`
- `backend/services/matchingEngine.js`

## Canonical Inputs

Profile facets are built from `profile_sections` using canonical section keys from `applicationSchema.json`.

Required facets for crawler execution:

1. `profile.primary_profile_type`
2. `geo.state_or_zip` (state or zip accepted)
3. `intent.primary_need_category`

`requireFacets()` enforces these requirements before crawler execution.

## Extraction Rules

`buildProfileFacets(profileContext)`:

1. Normalizes sections through `SECTION_MAPPERS`.
2. Extracts relevant fields using schema `source_section_key` + `source_path`.
3. Applies fallbacks from `fallback_source_path`.
4. Derives intent fields:
   - `intent.primary_need_category`
   - `intent.keywords`
   - `intent.negative_keywords`
5. Applies PII masking rules:
   - stores booleans and masked last4 only
   - no raw SSN/Medicaid identifiers in facets
6. Returns `facets`, `coverage`, and `trace`.

Coverage includes:

- handled/unhandled sections
- required missing facets
- field map coverage percentages
- PII summary flags

## Query Planning

`planCrawlerQueries({ crawlerType, facets, location })` creates:

- `mustTerms`, `shouldTerms`, `mustNotTerms`
- `preferredSponsors`
- `authorityDomainsAllowlist` and `authorityDomainsBlocklist`
- `requiredConcepts`
- `dedupeKeys`

Intent disambiguation includes targeted rules for:

- food truck business intent vs food bank assistance
- strike hardship assistance
- teacher classroom supplies
- nurse licensure/training
- ECF CHOICES and state analog terms

## Crawler Output Contract

`enforceCrawlerOpportunityContract()` enforces a shared crawler response shape:

- valid `http(s)` URL required
- non-empty title required
- query-plan must-not terms enforced
- normalized arrays for keywords/categories/eligibility
- `record_origin`, `source_url`, `application_url`, `match_reasons` consistently set

## Matching Engine Facet Scoring

`calculateMatchScore()` applies deterministic scoring plus `calculateFacetAdjustments()`:

- facet intent/category boosts
- keyword overlap boosts
- negative keyword penalties
- profile-attribute alignment boosts (student, business, veteran, disability, low-income)
- soft mismatch penalties only (no hard exclusions)

Existing loan/credit-repair penalties are preserved.

Debug toggle:

- `MATCHING_ENGINE_FACET_DEBUG=true` logs per-opportunity facet adjustment summaries.

## Real Crawler Route Observability

`/api/real-crawlers/run` adds `debug_meta` (when `admin=true`) with:

- `used_facets`
- `query_plan`
- `validation_rejection_counts`

This keeps the extraction -> planning -> filtering path traceable without changing the API success shape.
