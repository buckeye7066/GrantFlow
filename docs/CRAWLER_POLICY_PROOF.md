# Crawler Policy Proof

This document describes how the GrantFlow opportunity policy is enforced across every code path,
what changed to implement it, and how to verify it.

---

## 1. What changed

### New module — `backend/services/crawlers/opportunityPolicy.js`

Single source of truth for all compliance checks. All other modules import from here.

| Export | Purpose |
|---|---|
| `isValidRealUrl(url)` | Returns `true` iff URL is valid `http/https` and not a placeholder domain |
| `isLoanLike(opp)` | Returns `true` if opportunity is a loan, microloan, or financing product |
| `isMatchingFunds(opp)` | Returns `true` if opportunity requires matching funds or cost-share |
| `isPlaceholderOpportunity(opp)` | Returns `true` if title/description contains stub text |
| `pickRealUrl(opp)` | Returns first valid real URL from an opp's URL fields, or `null` |
| `enforceOpportunityPolicy(opp)` | Orchestrator: returns `{ ok: boolean, reason: string\|null }` |
| `getPolicyRejectionCounts()` | Returns module-level rejection counters (by reason) |
| `resetPolicyRejectionCounts()` | Resets all counters to zero |

Rejection reasons tracked: `no_real_url`, `placeholder_text`, `loan_like`, `matching_funds`, `invalid_object`.

### Changed — `backend/routes/realCrawlers.js`

1. **`normalizeLiveOpportunity`**: now calls `enforceOpportunityPolicy` first; replaces the old
   ad-hoc URL check + loan-type-only check with the full policy.

2. **`runLiveCrawler`**: calls `resetPolicyRejectionCounts()` before each run; returns merged
   counts (`rejectionCounts + getPolicyRejectionCounts()`) in `validation_rejection_counts`.

3. **Rescored live results**: policy applied after scoring (`.filter(row => enforceOpportunityPolicy(row).ok)`)
   so no loan or matching-fund opp can sneak through after score adjustment.

4. **`formatDbOpportunity`**: now calls `enforceOpportunityPolicy`; returns `null` for any record
   that fails policy so it is silently dropped before scoring.

5. **DB fallback scoring path**: calls `resetPolicyRejectionCounts()` then `.filter(enforceOpportunityPolicy)`
   after `calculateMatchScore`; stores counts in `debug.db.policy_rejection_counts`.

6. **`buildCandidateOpportunityQuery`**: matching-funds exclusion is now **unconditional** (was previously
   behind `HARD_FILTER_REQUIRES_MATCH` / `HARD_FILTER_MATCH_PERCENTAGE` env flags):
   - `(requires_match IS NULL OR requires_match = 0/FALSE)`
   - `(match_percentage IS NULL OR match_percentage = 0)`
   - Loan exclusion on `opportunity_type` also unconditional.

### Changed — `backend/services/opportunityInserter.js`

Imports `isValidRealUrl`, `isLoanLike`, `isMatchingFunds` from `opportunityPolicy.js` instead of
`crawlerOpportunityContract.js`. Behavior is identical; the source of truth is now consolidated.

### Changed — `backend/services/crawlers/localFundingCrawler.js`

- Imports `enforceOpportunityPolicy` from `opportunityPolicy.js`.
- Scoring loop: replaced `if (isLoanOrMatchingFund(opp)) continue` with
  `if (!enforceOpportunityPolicy(opp).ok) continue` for full policy coverage.
- `extractInterestedSchoolZips()` is called and anchor list is confirmed as
  `[profileZip, ...schoolZips]` (up to 4 anchors, 25-mile radius, hard-enforced).

### Changed — `backend/services/crawlers/studentGrantsCrawler.js`

- Imports `enforceOpportunityPolicy`.
- Added `extractFafsaSignals(profile, signals)` helper that reads:
  - `pell_eligible`, `efc`/`sai`, `high_financial_need`, `need_level`, `low_income`, `dependency_status`
  from `profile.sections.financial_information` / `sections.financial`.
- Federal student aid gate now also checks `fafsaSignals.pellEligible` / `fafsaSignals.highNeed` /
  `fafsaSignals.lowIncome` in addition to the existing signal checks.
- Section 4 (school-specific financial aid) now also reads `education.interested_schools` (not just
  `university_applications.applications`).
- Added `generateSchoolFinAidUrl(schoolName)` for deterministic URL pattern generation when the
  school is not in the known-URL lookup table.
- `enforceOpportunityPolicy` applied to every opportunity before scoring in all 4 sections.

---

## 2. Policy enforcement map

```
Opportunity lifecycle
─────────────────────

  Live crawler output
        │
        ▼
  normalizeLiveOpportunity()     ← enforceOpportunityPolicy (URL, placeholder, loan, match-funds)
        │
        ▼
  mustNotTerms filter            ← query-plan keyword exclusions
        │
        ▼
  isOpportunityCurrent()         ← deadline check
        │
        ▼
  calculateMatchScore()          ← full profile scoring
        │
        ▼
  post-score policy filter       ← enforceOpportunityPolicy (final guard on rescored opps)
        │
        ▼
  min_match_score threshold      ← slider value from Discover Grants
        │
        ▼
  bulkUpsertFundingOpportunities ← opportunityInserter validates URL + loan/match again

  DB fallback path
        │
        ▼
  buildCandidateOpportunityQuery ← SQL WHERE: no loans (opp type), no requires_match, no match%
        │
        ▼
  formatDbOpportunity()          ← enforceOpportunityPolicy (drops bad DB records silently)
        │
        ▼
  isOpportunityCurrent()
        │
        ▼
  calculateMatchScore()
        │
        ▼
  post-score policy filter       ← enforceOpportunityPolicy
        │
        ▼
  min_match_score threshold
```

---

## 3. Running tests

```bash
# Unit tests — opportunityPolicy module (49 tests)
node --test tests/unit/opportunityPolicy.test.mjs

# Unit tests — URL/loan validation helpers (23 tests)
node --test tests/unit/crawlerValidationHelpers.test.mjs

# Integration tests — DB fallback pipeline with forbidden opps (2 tests)
node --test tests/unit/realCrawlers-pipeline-policy.test.mjs

# Original contract + inserter tests
node --test tests/unit/crawler.contract.test.mjs tests/unit/opportunityInserter.test.mjs

# Full unit suite
node --test tests/unit/
```

---

## 4. Running the debug script

The `check-crawler-results.mjs` script runs a crawler against the live API and prints a summary
including policy rejection counts (why opportunities were dropped).

```bash
# Start the server in another terminal, then:
ADMIN_TOKEN=<your-jwt> node backend/scripts/check-crawler-results.mjs government_funding <profile_uuid> 50
ADMIN_TOKEN=<your-jwt> node backend/scripts/check-crawler-results.mjs local_funding <profile_uuid> 0
ADMIN_TOKEN=<your-jwt> node backend/scripts/check-crawler-results.mjs student_grants <profile_uuid> 60
```

Example output:

```
────────────────────────────────────────────────────────────
  RESPONSE SUMMARY
────────────────────────────────────────────────────────────
  success         : true
  count_returned  : 12
  total_found     : 45
  min_match_score : 50
  used_live       : true
  used_db_fallback: false

────────────────────────────────────────────────────────────
  POLICY REJECTIONS (total: 8)
────────────────────────────────────────────────────────────
     5  █████  loan_like
     2  ██     no_real_url
     1  █      matching_funds
```

---

## 5. Invariants guaranteed by this implementation

| Rule | Enforced by |
|---|---|
| All opportunities have a valid `http/https` URL | `enforceOpportunityPolicy` in `normalizeLiveOpportunity`, `formatDbOpportunity`, inserter |
| No placeholder domains (example.com/org/gov, localhost) | `isValidRealUrl` → `isPlaceholderHostname` |
| No loans (`opportunity_type`, `is_loan`, keyword) | `isLoanLike` in policy + SQL `NOT IN ('loan','loan_program','microloan')` |
| No matching-funds (`requires_match`, `match_percentage`, keyword) | `isMatchingFunds` in policy + SQL `WHERE requires_match=0 AND match_percentage=0` |
| No placeholder content (lorem ipsum, TBD, etc.) | `isPlaceholderOpportunity` in policy |
| min_match_score slider enforced | Threshold filter after scoring in live + DB paths |
| Local crawler radius exactly 25 miles | `radiusMiles = DEFAULT_SEARCH_RADIUS_MILES` (const, no override) |
| Local crawler anchors include school ZIPs | `extractInterestedSchoolZips()` called for `[profileZip, ...schoolZips]` |
| Student crawler uses FAFSA/need signals | `extractFafsaSignals()` gates federal aid and expands school pages |
| Geo crawler not profile-based | No `profile_id` required; stores by `state`+`zip` in `funding_opportunity_geo_index` |
