# Matching Architecture

## Overview

GrantFlow's matching system determines which funding opportunities are appropriate for a given profile. This document describes the decision pipeline, persistence model, matcher versioning, and admin re-evaluation job.

## Decision Engine Pipeline

All matching is routed through a single shared engine:

```
backend/services/matchDecisionEngine.js
```

### Exported Functions

| Function | Purpose |
|---|---|
| `normalizeProfile(profile, sections?)` | Converts raw profile data to canonical normalized form |
| `normalizeOpportunity(opportunity)` | Extracts structured eligibility from raw opportunity data |
| `evaluateEligibility(profileNorm, oppNorm)` | Hard eligibility checks (loan, closed deadline, geo, entity type) |
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
  matcherVersion: "1.0.0",
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
   - State-specific opportunity but profile is in a different state

2. **REVIEW**: No hard ineligibility but:
   - Score < 40, OR
   - Missing eligibility fields (unknown location, no entity type, no application URL)

3. **ACCEPT**: Eligible AND score ≥ 40 AND needAlignment > 0

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

### `backend/services/opportunityNormalizer.js`

- `normalizeOpportunity(rawOpp)` → structured eligibility
- `computeOpportunityFingerprint(normalizedOpp)` → SHA-256 hash

Extracts from title/description/eligibility_bullets:
- `entityTypesAllowed[]` — who can apply
- `needTypesSupported[]` — what needs it covers
- `fundingType` — grant/scholarship/loan/voucher/...
- `deadlineStatus` — open/rolling/closed/unknown
- `requiresVeteran`, `requiresStudent`, `requiresNonprofit`, `requiresBusiness`

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

Current version: **1.0.0** (defined as `MATCHER_VERSION` in `matchDecisionEngine.js`)

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
  "matcherVersion": "1.0.0"
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

The following callers use `saveToProfilePipeline`:
- `backend/services/localCrawler.js`
- `backend/services/comprehensiveCrawlerOptimized.js`
- `backend/services/anyaAutonomousFunctionRunner.js`
- `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs`

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

Tests are in `tests/unit/matchDecisionEngine.test.mjs`.

### Coverage

1. **Profile normalization aliasing** — medical→health_medical, family→family_life, etc.
2. **Opportunity normalization** — entity type extraction, deadline status, funding type
3. **Eligibility decisions** — loan, closed deadline, veteran/student/nonprofit/business requirements, geo mismatch
4. **Need-type alignment** — full overlap, no overlap, partial overlap
5. **Source trust scoring** — .gov, .edu, .org, no URL, curated_verified
6. **computeMatchDecision() integration** — REJECT/ACCEPT/REVIEW scenarios, structured output
7. **Persistence** — decision output has all required DB columns, fingerprint changes trigger re-evaluation
8. **Regression tests**:
   - Student aid NOT shown to non-student
   - FEMA/disaster NOT shown without disaster context  
   - Business grant NOT shown to non-business individual
   - Nonprofit grant NOT shown to individual
   - Geographic mismatch NOT shown outside eligible region
   - Loan always REJECTED
9. **Positive tests** — veteran gets veteran grant, student gets education grant, etc.

### Running Tests

```sh
node --test tests/unit/matchDecisionEngine.test.mjs
```

Or as part of the full suite:

```sh
npm run unit
```
