# Matching Architecture

## Overview

GrantFlow's matching system determines which funding opportunities are appropriate for a given profile. This document describes the decision pipeline, persistence model, matcher versioning, and admin re-evaluation job.

## Decision Engine Pipeline

All matching is routed through a single shared engine:

```
backend/services/matchDecisionEngine.js
```

**MATCHER_VERSION: 2.0.0** — Legacy `calculateMatchScore` fallback removed. `computeMatchDecision()` is the sole authority.

### Exported Functions

| Function | Purpose |
|---|---|
| `normalizeProfile(profile, sections?)` | Converts raw profile data to canonical normalized form |
| `normalizeOpportunity(opportunity)` | Extracts structured eligibility from raw opportunity data |
| `evaluateEligibility(profileNorm, oppNorm)` | Hard eligibility checks (loan, closed deadline, geo, entity type, disease-specific, institutional, disaster) |
| `calculateNeedAlignment(profileNorm, oppNorm)` | Need-to-funding-type mapping score |
| `calculateSourceTrust(opportunity)` | Source quality/trust score |
| `computeMatchDecision(rawProfile, rawOpp, opts?)` | Full structured decision |

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
  matcherVersion: "2.0.0",
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

Current version: **2.0.0** (defined as `MATCHER_VERSION` in `matchDecisionEngine.js`)

**Breaking changes in v2.0.0:**
- Legacy `calculateMatchScore` fallback removed from `opportunityMatcher.js`
- `computeMatchDecision()` is the sole authority for all pipeline decisions
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
  "matcherVersion": "2.0.0"
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

**Legacy fallback removed (v2.0.0)**: `opportunityMatcher.js` no longer imports or calls `calculateMatchScore` from `matchingEngine.js`. `computeMatchDecision()` is the sole scoring authority.

The following callers use `saveToProfilePipeline`:
- `backend/services/localCrawler.js`
- `backend/services/comprehensiveCrawlerOptimized.js`
- `backend/services/anyaAutonomousFunctionRunner.js`
- `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs`

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

## Source Trust Scoring

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
- `tests/unit/matchDecisionEngine.comprehensive.test.mjs` (v2 regression harness — 54 tests)

### Comprehensive Test Coverage (v2)

1. **MATCHER_VERSION** is `2.0.0`
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

### Running Tests

```sh
node --test tests/unit/matchDecisionEngine.test.mjs
node --test tests/unit/matchDecisionEngine.comprehensive.test.mjs
```

Or as part of the full suite:

```sh
npm run unit
```

