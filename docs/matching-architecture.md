# Matching Architecture

## Overview

GrantFlow's matching system determines which funding opportunities are appropriate for a given profile. This document describes the decision pipeline, persistence model, matcher versioning, and admin re-evaluation job.

## Decision Engine Pipeline

All matching is routed through a single canonical engine:

```
backend/services/matchEngine.js          # canonical implementation
backend/services/matchDecisionEngine.js  # compatibility re-export shim
backend/services/matchingEngine.js       # legacy shim (calculateMatchScore → scoreOpportunity)
```

Callers should import directly from `matchEngine.js`. `matchDecisionEngine.js`
is a thin `export { ... } from './matchEngine.js'` file preserved so older
callers continue to compile against the v2 names; it adds no behavior of its
own. `matchingEngine.js` is a tiny wrapper that exposes the legacy
`calculateMatchScore(profile, opp)` entry point, which is just
`scoreOpportunity(profile, opp)` — a scoring helper only, NEVER an acceptance
authority.

**MATCHER_VERSION: 4.1.2** — `computeMatchDecision()` is the sole
acceptance/rejection authority. `scoreOpportunity()` /
`calculateMatchScore()` return a raw score only and are used solely for
lightweight ranking and junk pre-filtering.

User-facing result paths (Discover, real crawlers, Anya context, pipeline
auto-add) are funnelled through
`backend/services/matching/resultEnricher.js`, which combines
`assessOpportunityTrust()` + `computeMatchDecision()` +
`deriveMatchReasonCodes()` and emits stable display fields. Crawler
prefilter scores are never treated as final user-facing scores.

### Exported Functions

| Function | Purpose |
|---|---|
| `normalizeProfile(profile, sections?)` | Converts raw profile data to canonical normalized form |
| `normalizeOpportunity(opportunity)` | Extracts structured eligibility from raw opportunity data |
| `evaluateEligibility(profileNorm, oppNorm)` | Hard eligibility checks (loan, closed deadline, geo, entity type, disease-specific, institutional, disaster) |
| `calculateNeedAlignment(profileNorm, oppNorm)` | Need-to-funding-type mapping score |
| `calculateSourceTrust(opportunity)` | Source quality/trust score |
| `scoreOpportunity(profile, opp)` | Raw score + reasons (non-authoritative) |
| `matchOpportunities(profile, opps[], opts?)` | Ranked list via `scoreOpportunity` |
| `makeDecision(score, profile, opp, profileNorm?)` | Decision step used internally by `computeMatchDecision` |
| `computeMatchDecision(rawProfile, rawOpp, opts?)` | Full structured decision — **sole acceptance authority** |

> Note on `computeMatchDecision` signature: it takes exactly
> `(rawProfile, rawOpportunity, opts?)`. It is NOT
> `(profile, opp, precomputedScore, precomputedReasons)` — there is no caller
> contract that accepts a pre-computed score; `scoreOpportunity` is invoked
> internally. Callers that passed extra args historically (e.g. a stale
> `itemCrawler` path) were silently ignoring those arguments.

### `computeMatchDecision()` return value

```js
{
  eligible: true | false | "maybe",
  ineligibilityReasons: string[],   // Why it's ineligible
  needAlignment: 0..100,            // Need overlap score
  score: 0..100,                    // Composite match score
  confidence: 0..100,               // Confidence in the decision
  decision: "ACCEPT" | "REVIEW" | "REJECT",
  matchedNeeds: string[],           // Which profile needs are satisfied
  matchedProfileTraits: string[],   // Which profile traits matched
  missingEligibilityFields: string[], // Fields needed but missing
  explanation: string,              // Human-readable summary
  matcherVersion: "4.1.2",
  evaluatedAt: ISO timestamp
}
```

### Decision Logic

1. **REJECT**: Any of the following applies:
   - Opportunity is a loan
   - Application deadline has passed
   - Veteran requirement but profile is not a veteran
   - Student requirement but profile is not a student
   - Nonprofit requirement but profile is not a nonprofit
   - Business requirement but profile is not a business
   - Institutional/research-only, but profile is an ordinary individual/family
   - Disease-specific, but profile has no chronic illness or disability indicator
   - Disaster/FEMA context required, but profile has no emergency need indicator
   - State-specific opportunity but profile is in a different state
   - Entity type mismatch (e.g., nonprofit-only grant for an individual)

2. **REVIEW**: No hard ineligibility, but:
   - `applicabilityUnknown = true` (opportunity entity types unclear — conservative, not false ACCEPT)
   - More than 2 missing eligibility fields
   - Score < 40, OR
   - `needAlignment = 0`, OR
   - No application URL found, OR
   - Confidence < 50

3. **ACCEPT**: All of the following:
   - `eligible = true` (no hard ineligibility)
   - `applicabilityUnknown = false`
   - `score ≥ 40`
   - `needAlignment > 0`
   - `hasApplicationUrl = true` (actionable path to apply)
   - `confidence ≥ 50`
   - `missingEligibilityFields.length ≤ 2`

### Score Composition

| Component | Weight |
|---|---|
| Need alignment (0-100) | 45% |
| Source trust (0-100) | 25% |
| Entity type match bonus | 20% |
| Geographic match bonus | 10% |

## Supporting Services

### `backend/services/profileNormalizer.js`

- `normalizeProfile(rawProfile, sections?)` → canonical profile
- `computeProfileFingerprint(normalizedProfile)` → SHA-256 hash of key fields
- `normalizeNeedCategory(raw)` → canonical need bucket
- `normalizeEntityType(raw)` → canonical entity type

**Alias map** (partial):

| Input | Canonical |
|---|---|
| medical, health, healthcare, prescription | `health_medical` |
| rent, rental_assistance, housing_instability, eviction | `housing` |
| family, caregiver, childcare | `family_life` |
| student, education, college, tuition | `education` |
| nonprofit, church, faith_based, 501c3 | (entity) `nonprofit` |
| small_business, entrepreneur, startup | (entity) `business` |

**Section-derived signals** (v2):

`normalizeProfile(profile, sections)` now derives richer truth from section content:

| Section Key | Derived Signal |
|---|---|
| `military_service` | `isVeteran` (from branch, discharge_status, served_in_military) |
| `education` | `isStudent` (from currently_enrolled, school_name, degree_program) |
| `business` / `self_employment` | `isBusiness` (from owns_business, ein, business_name) |
| `family_life` / `caregiving` | `isCaregiver`, `hasFosterIndicator` (from is_caregiver, has_dependents, foster_status) |
| `health_medical` / `medical` | `hasChronicIllness`, `hasDisabilityNeed` (from has_disability, conditions, diagnoses) |
| `emergency` / `disaster` | `hasEmergencyNeed` (from disaster_affected, fema_eligible) |
| `housing` | `hasHousingNeed` (from risk_of_eviction, housing_instability) |
| `location` / `address` | `state`, `zip`, `city` — fallback when top-level is incomplete |

**Normalized profile structure:**

```js
{
  id, entityType, state, zip, county, city,
  needCategories: string[],    // Canonical need buckets
  isVeteran, isStudent, isNonprofit, isBusiness,
  isCaregiver, hasFosterIndicator,
  hasChronicIllness, hasDisabilityNeed,
  hasEmergencyNeed, hasHousingNeed, hasEmploymentNeed, hasBusinessNeed,
  age, displayName
}
```

### `backend/services/opportunityNormalizer.js`

- `normalizeOpportunity(rawOpp)` → structured eligibility (conservative)
- `computeOpportunityFingerprint(normalizedOpp)` → SHA-256 hash

**Conservative design** (v2): Unknown applicability is tracked as `applicabilityUnknown: true`
rather than defaulting to `['individual']`. This forces REVIEW instead of false ACCEPT.

Extracts from title/description/eligibility_bullets:
- `entityTypesAllowed[]` — who can apply (empty + `applicabilityUnknown=true` if unclear)
- `applicabilityUnknown` — true when entity eligibility could not be determined
- `needTypesSupported[]` — what needs it covers
- `fundingType` — grant/scholarship/loan/voucher/...
- `deadlineStatus` — open/rolling/closed/unknown
- `requiresVeteran`, `requiresStudent`, `requiresNonprofit`, `requiresBusiness`
- `isLoan`, `isProBono`, `isInKind`, `isReferralOnly`
- `isInstitutionalOnly`, `isResearchOnly`
- `diseaseSpecific`, `requiresDisasterContext`
- `isDmeOrEquipment`, `isCaregiverProgram`

## Persistence Model

### Schema Additions (Migration 036)

**`grants` table** (pipeline entries):

| Column | Type | Description |
|---|---|---|
| `match_decision` | TEXT | ACCEPT/REVIEW/REJECT |
| `match_explanation` | TEXT | Human-readable reason |
| `matched_needs` | TEXT (JSON) | Which needs were satisfied |
| `eligibility_status` | TEXT | true/false/maybe |
| `ineligibility_reasons` | TEXT (JSON) | Why rejected/reviewed |
| `profile_fingerprint` | TEXT | Profile hash at eval time |
| `opportunity_fingerprint` | TEXT | Opportunity hash at eval time |
| `matcher_version` | TEXT | Engine version used |
| `evaluated_at` | DATETIME | When evaluated |
| `match_confidence` | INTEGER | Confidence score 0-100 |

**`funding_opportunities` table**:

| Column | Type | Description |
|---|---|---|
| `entity_types_allowed` | TEXT (JSON) | Who can apply |
| `need_types_supported` | TEXT (JSON) | Needs covered |
| `deadline_status` | TEXT | open/rolling/closed/unknown |
| `official_source_type` | TEXT | Source quality classification |
| `source_trust_score` | INTEGER | Trust score 0-100 |
| `opportunity_fingerprint` | TEXT | Normalized hash |

**`profiles` table**:

| Column | Type | Description |
|---|---|---|
| `profile_fingerprint` | TEXT | Hash of canonical profile fields |
| `normalized_snapshot` | TEXT (JSON) | Cached normalized profile |

### Persistence Guarantee

Pipeline entries (grants table) include the `matcher_version`, `profile_fingerprint`, and `opportunity_fingerprint` at the time of evaluation. This means:

1. If a profile's location or needs change, `profile_fingerprint` changes → re-evaluation can be triggered.
2. If an opportunity's eligibility fields change, `opportunity_fingerprint` changes → re-evaluation can be triggered.
3. If `matcher_version` changes → all existing entries with older versions should be re-evaluated.

## Matcher Versioning

Current version: **4.1.2** (defined as `MATCHER_VERSION` in
`backend/services/matchEngine.js`; re-exported by
`backend/services/matchDecisionEngine.js`)

**Changes from v4.0.0 → v4.1.2 relevant to callers:**
- Generic / category-empty opportunities now score modestly (max ~45) so
  filler rows no longer surface as strong matches.
- `scoreCategoryComponent` baseline lowered (15) and floor lowered (5) to
  prevent generic directories from looking like strong matches.
- `scoreEligibilityComponent` baseline lowered (35) and soft type mismatch
  penalty increased (-25) so misaligned entity types lose more score.
- `matchOpportunities(opts)` now accepts `strictMinScore: true` to disable
  automatic relaxation — used by Discover slider strict mode.
- The numeric threshold in `opportunityMatcher.saveToProfilePipeline` is no
  longer bypassed by ACCEPT/REVIEW. Relevance filter runs in soft mode and
  penalties feed into the score before the threshold check.

**Changes from v2.0.0 → v4.0.0 relevant to callers:**
- `matchEngine.js` is the single implementation; `matchDecisionEngine.js` is a
  thin re-export, `matchingEngine.js` is a legacy scoring-only shim.
- `computeMatchDecision(rawProfile, rawOpportunity, opts?)` — no stale
  `(profile, opp, score, reasons)` shape; extra args in legacy callers are
  silently ignored and have been removed.
- `computeMatchDecision()` remains the sole authority for all pipeline decisions.
- Unknown opportunity applicability no longer defaults to `['individual']`; forces REVIEW instead
- ACCEPT now requires: `hasApplicationUrl`, `confidence ≥ 50`, `needAlignment > 0`, `applicabilityUnknown = false`
- New hard-reject classes: institutional/research-only, disease-specific, disaster/FEMA context required
- Profile normalization derives richer signals from section content (caregiver, veteran, student, business, disability, emergency, housing, location)

When the matching logic changes in a backward-incompatible way:
1. Increment `MATCHER_VERSION`
2. Run the admin backfill job to re-evaluate all existing pipeline entries

## Admin Re-Evaluation Job

### `POST /api/admin/backfill-matches`

Requires admin authentication.

Re-evaluates all existing pipeline entries using the current decision engine:
- Loads each `grants` entry with associated opportunity and profile data
- Calls `computeMatchDecision()` for each pair
- **REJECT** entries are deleted from the pipeline
- **ACCEPT/REVIEW** entries have their metadata updated

**Response:**
```json
{
  "success": true,
  "total": 1234,
  "accepted": 890,
  "reviewed": 123,
  "rejected": 221,
  "errors": 0,
  "matcherVersion": "4.1.2"
}
```

Run migration first:
```sh
npm run migrate
```

Then trigger backfill:
```sh
curl -X POST https://your-app.railway.app/api/admin/backfill-matches \
  -H "Authorization: Bearer <admin-token>"
```

## Insertion Paths

All insertion paths go through `saveToProfilePipeline()` in `opportunityMatcher.js`, which calls `computeMatchDecision()` before saving.

**Hard REJECT gate**: If `decision.decision === 'REJECT'`, the entry is NOT saved regardless of the raw score.

**Legacy fallback removed**: `opportunityMatcher.js` no longer calls
`calculateMatchScore` as an acceptance authority. `computeMatchDecision()` is
the sole decision authority; `calculateMatchScore` / `scoreOpportunity` are
used only as non-authoritative ranking helpers.

### Path audit (v4.1.2)

| Path | Status | Notes |
|---|---|---|
| `backend/crawler-os/matchEngine.js` | ✅ canonical facade (v4.1.2) | Adapts Crawler OS opportunity/thesis rows into `computeMatchDecision`; contains no standalone decision weights |
| `backend/services/opportunityMatcher.js:saveToProfilePipeline` | ✅ canonical | Production pipeline insertion — sole INSERT authority |
| `backend/services/itemCrawler.js` | ✅ canonical (v4.1.2) | Uses `computeMatchDecision(profile, opp)` with explicit camelCase→snake_case mapping into `upsertFundingOpportunity` |
| `backend/services/localCrawler.js` | ✅ canonical | Calls `saveToProfilePipeline` |
| `backend/services/comprehensiveCrawlerOptimized.js` | ✅ canonical | Calls `saveToProfilePipeline` |
| `backend/services/anyaAutonomousFunctionRunner.js` | ✅ canonical | Calls `saveToProfilePipeline` |
| `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs` | ✅ canonical | Calls `saveToProfilePipeline` |
| `backend/routes/admin.js POST /api/admin/backfill-matches` | ✅ canonical | Re-evaluates using `computeMatchDecision` |
| `backend/utils/seedOnStartup.js` | ✅ canonical | Inserts into `funding_opportunities`, not grants pipeline |
| `backend/scripts/seed-profile-grants.mjs` | ✅ canonical | Dev-only; guarded by NODE_ENV/DISABLE_SEEDING; uses `computeMatchDecision` |
| `scripts/seed-profile-grants.mjs` | ✅ canonical (v4.1.2) | Dev-only; guarded by NODE_ENV/DISABLE_SEEDING; heuristic pre-score via canonical `scoreOpportunity`; `computeMatchDecision` is sole acceptance authority |
| `scripts/seed-matched-grants.mjs` | ✅ canonical | Dev-only; guarded by NODE_ENV/DISABLE_SEEDING; uses `computeMatchDecision` |
| `backend/scripts/create-orgs-and-grants.mjs` | ❌ hard-disabled | Throws on load; previous body inserted random placeholder data, bypassing `computeMatchDecision` |

## Relevance Filter

`backend/services/relevanceFilter.js` provides an additional hard-disqualification layer applied
within `saveToProfilePipeline()`. It acts as a complementary safety net to `evaluateEligibility()`,
not as a competing authority.

**Relationship:**
- `evaluateEligibility()` = canonical canonical eligibility authority (entity type, geography, loan, requirements, disease-specific, institutional, disaster context)
- `relevanceFilter.js` = additional regex/pattern safety net applied after the decision engine

The relevance filter is applied before the pipeline INSERT to catch any patterns not yet covered
by `evaluateEligibility()`. Over time, patterns should be promoted from `relevanceFilter.js` into
`evaluateEligibility()` to maintain the canonical architecture.

## Candidate Selection Strategy (Pre-Canonical Filtering)

### Two-Stage Filtering Approach

All seeding paths use a **two-stage** strategy to balance correctness and performance:

#### Stage 1 — Lightweight Junk Filter
A local heuristic scorer based on keyword overlap, geographic signals, and intent phrases is applied first. This stage **only removes clear garbage** (heuristic score < 5). Its sole purpose is to avoid calling the canonical engine on completely irrelevant opportunities (e.g., a state-specific program for California being evaluated for a New York profile with no matching signals).

**Critical constraint**: Stage 1 must **never** exclude plausible canonical matches. Profiles with weak keyword tags but strong section-derived signals (e.g., `military_service.veteran = true`, `health_medical.disability_type`, `family_life.family_caregiver = true`) must still pass Stage 1 and reach the canonical engine.

#### Stage 2 — Canonical Decision Engine
`computeMatchDecision()` is the **sole acceptance authority**. No opportunity is saved to the pipeline unless the canonical engine returns ACCEPT or REVIEW. The canonical engine:
- Performs hard eligibility checks (loans, demographic requirements, entity type, geography)
- Calculates need alignment from normalized profile + opportunity data
- Normalizes section-derived signals (veteran status, disability, caregiver, etc.)
- Applies confidence and actionability checks (application URL, missing fields)

### Which Paths Use Pre-Filtering

| Path | Stage 1 Threshold | Stage 2 Gate | Notes |
|---|---|---|---|
| `backend/utils/seedOnStartup.js:seedProfileGrants()` | heuristic ≥ 5 | `computeMatchDecision` ACCEPT/REVIEW | Safe: threshold is very low |
| `backend/scripts/seed-profile-grants.mjs` | heuristic ≥ 5 | `computeMatchDecision` ACCEPT/REVIEW; then post-decision score ≥ 40 (matches canonical ACCEPT minimum) | Safe: canonical runs first, score check is post-evaluation |
| `scripts/seed-profile-grants.mjs` | heuristic ≥ 5 | `computeMatchDecision` ACCEPT/REVIEW | Safe: adaptive cap (≤200 evaluate all, >200 take top 200) |
| `scripts/seed-matched-grants.mjs` | heuristic ≥ 5 | `computeMatchDecision` ACCEPT/REVIEW | Safe: adaptive cap (≤200 evaluate all, >200 take top 200) |
| `backend/services/opportunityMatcher.js:saveToProfilePipeline()` | none (no heuristic) | `computeMatchDecision` ACCEPT/REVIEW | Canonical-only; no heuristic pre-filter |
| `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs` | none | delegates to `saveToProfilePipeline()` | Safe: no pre-filtering |

### Why Remaining Pre-Filters Are Safe

1. **Threshold is extremely permissive (< 5)**: A score of 0-4 requires essentially zero signal overlap — not even geographic, keyword, or intent phrase matches. A caregiver profile with caregiver section data evaluating a caregiver program will score well above 5 even with zero tag overlap.

2. **Section-derived signals pass**: The heuristic uses `buildProfileSignals()` which reads section data (not just top-level tags). Veteran status from `military_service`, disability from `health_medical`, caregiver from `family_life` all produce keyword signals that raise the heuristic score above the junk threshold.

3. **Geographic mismatch is a soft penalty, not a hard disqualification**: The heuristic subtracts points for wrong-state opportunities but does not zero them out. National opportunities always score above 5.

4. `applyRelevanceFilter()` is applied after Stage 1 as a hard-disqualification safety net — it only blocks clear demographic/entity mismatches (veteran-only for non-veterans, student-only for non-students, etc.) and passes conservatively when profile data is missing.

### Performance Strategy

- **Adaptive candidate pool cap**: The junk filter (heuristic < 5) eliminates the vast majority of irrelevant candidates. Of the remaining candidates:
  - If ≤ 200 junk-filtered candidates remain, **all** are evaluated canonically — no cap.
  - If > 200 remain, they are sorted by heuristic score and the **top 200** are passed to the canonical engine. This generous ceiling makes it virtually impossible to miss a strong canonical match while keeping performance bounded.
  - The constant `ADAPTIVE_CANDIDATE_CAP = 200` is defined explicitly in each seeding script.
  - `computeMatchDecision()` remains the sole acceptance authority; the adaptive cap only bounds the candidate pool, never substitutes for canonical evaluation.
- **SQL LIMIT 500**: The database query fetches up to 500 active opportunities before heuristic scoring, ensuring sufficient coverage without loading the entire database.
- **Canonical engine is not brute-forced**: The junk filter ensures the canonical engine only processes plausible candidates, maintaining acceptable performance at scale.

### False Positive vs False Negative Trade-off

- **At Stage 1 (candidate selection)**: Prefer **false positives** over false negatives. It is better to send an extra candidate to canonical evaluation than to exclude a strong canonical match prematurely.
- **At Stage 2 (canonical decision)**: Prefer **conservative correctness**. The canonical engine must not lower its ACCEPT criteria to increase recall. ACCEPT requires score ≥ 40, needAlignment > 0, confidence ≥ 50, and a valid application URL.



| Source | Score |
|---|---|
| Official .gov domains (grants.gov, va.gov, etc.) | 95 |
| Any .gov URL | 90 |
| .edu URL | 75 |
| Trusted intermediaries (211.org, unitedway.org, etc.) | 70 |
| .org URL | 60 |
| curated_verified record_origin | 80 |
| curated_benefits/program | 65 |
| live_crawl | 40 |
| No URL | 10 |

## Test Plan

Tests are in:
- `tests/unit/matchDecisionEngine.test.mjs` (existing — 55 tests)
- `tests/unit/matchDecisionEngine.comprehensive.test.mjs` (v2 regression harness — 63 tests)
- `tests/unit/matchDecisionEngine.lifecycle.test.mjs` (lifecycle / pipeline tests — 16 tests)
- `tests/unit/candidate-prefilter-safety.test.mjs` (pre-filter safety regression — 8 tests)
- `tests/unit/canonical-authority-sweep.test.mjs` (enforces `matchEngine.js`
  as the sole acceptance authority; `matchingEngine.js` is strictly a
  scoring-only legacy shim)
- `tests/unit/architecture-drift-audit.test.mjs` (prefilter-conservatism
  invariants, shared `opportunityPolicy` primitives, stale-doc prevention,
  Anya domain audits)
- `tests/unit/crawler-policy-proof.test.mjs` (executable version of the
  guarantees documented in `docs/CRAWLER_POLICY_PROOF.md`)

### Comprehensive Test Coverage

1. **MATCHER_VERSION** is `4.1.2`
2. **Profile classes** (ACCEPT/REVIEW/REJECT for each):
   - Caregiver/family profile
   - Student profile (including non-student REJECT for student-only)
   - Veteran profile (including section-derived flag)
   - Nonprofit/ministry profile (including individual REJECT for nonprofit-only)
   - Business/startup profile (including section-derived flag)
   - Disability/medical profile (including section-derived flags)
   - Emergency/disaster profile (including section-derived flag)
   - Ordinary individual with housing/utilities need
3. **Unknown applicability** → `applicabilityUnknown=true`, never ACCEPT
4. **ACCEPT requires needAlignment > 0**
5. **ACCEPT requires hasApplicationUrl**
6. **Institutional/research-only** → REJECT for ordinary individuals
7. **Disease-specific** → REJECT when profile lacks condition indicator
8. **Disaster/FEMA** → REJECT when profile lacks emergency context
9. **Section-derived signals** for veteran, student, business, caregiver, disability, emergency, location
10. **Fingerprint v2** includes `applicabilityUnknown`, `isCaregiver`, `hasChronicIllness`
11. **New opportunity flags** (`isProBono`, `isInKind`, `isInstitutionalOnly`, `requiresDisasterContext`, `isDmeOrEquipment`, `diseaseSpecific`)

### Lifecycle / Pipeline Tests

`tests/unit/matchDecisionEngine.lifecycle.test.mjs` covers:

1. **Profile-id scoping**: grants are stored with the correct `profile_id`
2. **Cross-profile isolation**: pipeline of profile A does not leak into profile B
3. **Duplicate prevention**: inserting the same opportunity twice is idempotent
4. **Stale re-evaluation**: rows with old `matcher_version` are detected and re-evaluated
5. **Null fingerprint detection**: rows without fingerprints are detected as never evaluated by the current matcher version
6. **REJECT removal**: stale rows that now produce REJECT (e.g. loan) are deleted from pipeline
7. **Profile fingerprint determinism**: same profile → same fingerprint; different state/needs → different fingerprint
8. **Opportunity fingerprint determinism**: same opportunity → same fingerprint; `is_loan` change → different fingerprint
9. **Canonical decision authority**: `computeMatchDecision` REJECT prevents pipeline INSERT via `saveToProfilePipeline`
10. **Seeding guard**: `seedFundingOpportunities` returns 0 when `DISABLE_SEEDING=true`
11. **Metadata persistence**: `matcher_version`, `profile_fingerprint`, `opportunity_fingerprint`, `match_decision`, `evaluated_at` all stored

### Running Tests

```sh
node --test tests/unit/matchDecisionEngine.test.mjs
node --test tests/unit/matchDecisionEngine.comprehensive.test.mjs
node --test tests/unit/matchDecisionEngine.lifecycle.test.mjs
node --test tests/unit/candidate-prefilter-safety.test.mjs
```

Or as part of the full suite:

```sh
npm run unit
```
