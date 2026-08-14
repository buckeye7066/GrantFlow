# GrantFlow Crawler System — Comprehensive Analysis

**Date:** February 28, 2026  
**Scope:** `backend/routes/realCrawlers.js`, `backend/services/crawlers/*`, `backend/services/matchingEngine.js`, `backend/services/opportunityInserter.js`

> **Historical snapshot — not current status.** Line references below have
> drifted (`backend/services/opportunityInserter.js` has grown substantially
> since this pass) and at least one finding has since shipped: **Issue #7**
> (deadline included in the `source_id` hash) is fixed —
> `stableSourceIdFromOpportunity()` (now ~line 353) explicitly excludes the
> deadline with the comment "Exclude deadline so deadline-only updates (e.g.
> extensions) don't create new records." `matchingEngine.js` is also since
> documented elsewhere (`docs/GRANTFLOW_MISSION_FIX_PLAN.md`) as "a deprecated
> shim" over `backend/services/matchEngine.js`, the canonical scorer — so
> Issue #2's premise (two competing live scoring engines) needs re-verification
> against the current call graph before treating it as an open defect.
> Reproduce each remaining issue against the current commit before acting on
> it; do not treat this document as a live defect list.

---

## Executive Summary

After a thorough code review of the crawler pipeline — from individual crawlers through orchestration, scoring, policy enforcement, persistence, and response assembly — I've identified **9 distinct issues** ranging from critical (duplicate results, dual scoring engines) to moderate (false positive filtering, score inflation). The issues fall into three categories:

1. **Duplicate results** — structural gaps in deduplication
2. **Scoring confusion** — two competing scoring engines with different algorithms and reversed argument signatures
3. **Overzealous or redundant filtering** — false positives in policy enforcement and triple-redundant policy checks

---

## Issue #1 — CRITICAL: Comprehensive Crawler Has No Cross-Crawler Dedup

**Location:** `realCrawlers.js` lines 524–552, 614–616

**Problem:** All 7 sub-crawlers independently query the same grants.gov API (`https://api.grants.gov/v1/api/search2`). When the `comprehensive` crawler runs them all in parallel, results are simply flattened:

```js
rawResults = results.flat()  // line 552 — no dedup
```

The same grant (e.g., a health-related disability grant) can be returned by `governmentFunding`, `healthResources`, `specialNeeds`, and `localFunding` simultaneously. While each individual crawler deduplicates *internally*, there is no dedup *across* crawlers before normalization.

The merge-dedup at lines 1326–1334 only handles live-vs-DB merging, not within-live dedup.

**Impact:** Users see the same opportunity 2–4 times in comprehensive results. The `.slice(0, 50)` cap means real unique results get crowded out by duplicates.

**Fix:** Add URL/title-based dedup immediately after `results.flat()`:

```js
const seen = new Set()
rawResults = results.flat().filter(row => {
  const key = String(row?.url || row?.application_url || row?.source_url || row?.title || '').toLowerCase()
  if (!key || seen.has(key)) return false
  seen.add(key)
  return true
})
```

---

## Issue #2 — CRITICAL: Two Competing Scoring Engines

**Locations:**
- `matchingEngine.js` → `calculateMatchScore(profileContext, opportunity)` — used by `realCrawlers.js` route layer
- `crawlerHelpers.js` → `calculateMatchScore(opportunity, profile)` — used by all individual crawlers

**Problem:** These are two entirely different scoring algorithms with **reversed argument signatures**:

| Aspect | matchingEngine.js | crawlerHelpers.js |
|--------|-------------------|-------------------|
| **Signature** | `(profileContext, opportunity)` | `(opportunity, profile)` |
| **Geo scoring** | Tiered: ZIP(25) → county(22) → city(20) → state(18) → national(8) → mismatch(-20) | Binary: national(15) or state match(20) or mismatch(-20) |
| **Applicant type** | 25 pts via `eligibilityMatchesApplicantType()` | 20 pts via text search |
| **Keywords** | Tiered: intent(5), phrases(3), single(1.5) | Keyword(2), phrase(2), broad keyword(2) |
| **Facet system** | Full facet adjustments (±35 pts) | No facet system |
| **Max components** | geo(25) + type(25) + kw(25) + cat(20) + facets(35) + amount(10) + deadline(5) | geo(20) + type(20) + demo(15) + mil(20) + health(15) + assist(15) + family(10) + kw(10) + phrase(10) + multi-cat(15) + evidence(8) |

**Score inflation from max-merge:** In `runLiveCrawler` (line 644):

```js
const mergedScore = existingScore === null ? computedScore : Math.max(existingScore, computedScore)
```

This takes the *higher* of the two different algorithms. A mediocre match scoring 60 from crawlerHelpers and 45 from matchingEngine appears as 60, not an averaged score. The algorithms measure different things so max-merging them inflates scores systematically.

**Impact:** Score inconsistency between crawlers. The same opportunity can score differently depending on which crawler finds it first. Comprehensive mode amplifies this because the max-merge always picks the most generous score.

**Fix:** Consolidate to a single scoring engine. The `matchingEngine.js` version is more sophisticated (facets, tiered geo, intent phrases). Individual crawlers should either: (a) not score at all and let the route layer handle all scoring, or (b) import and use `matchingEngine.calculateMatchScore`. The max-merge should become a single-source scoring call.

---

## Issue #3 — MODERATE: ECF Benefits Crawler Has No Dedup

**Location:** `services/crawlers/ecfBenefitsCrawler.js`

**Problem:** Every other crawler has internal URL-based dedup (`seenUrls` Set). The ECF benefits crawler has none. If the same ECF benefit appears from multiple search strategies or API pages, it will be returned multiple times.

**Impact:** Duplicate ECF benefits in results.

**Fix:** Add standard `seenUrls` dedup to `crawlECFBenefits()` before returning results.

---

## Issue #4 — MODERATE: Triple Policy Enforcement (Redundant)

**Locations:**
1. `normalizeLiveOpportunity` (line 350): `enforceOpportunityPolicy(raw)` 
2. Post-scoring filter (line 650): `enforceOpportunityPolicy(row)` after rescoring
3. `formatDbOpportunity` (line 733): `enforceOpportunityPolicy(formatted)`
4. `buildCandidateOpportunityQuery` (line 744–756): SQL-level hard exclusions for loans/matching-funds

**Problem:** The same opportunity is policy-checked 2 times in the live path and 2 times in the DB path. This is safe (defense-in-depth) but causes the `_rejectionCounts` to double-count rejections, making the debug stats misleading. The module-level counter in `opportunityPolicy.js` is shared across all calls without distinguishing which enforcement point triggered the rejection.

**Impact:** Debug stats show inflated rejection counts. Not a functional issue.

**Fix:** Either remove the second live-path check (since normalization already applied policy), or scope rejection counters per enforcement point. The SQL-level exclusions should stay as they prevent unnecessary row processing.

---

## Issue #5 — MODERATE: Loan Keyword Detection False Positives

**Location:** `opportunityPolicy.js` lines 70–78

**Problem:** The `LOAN_KEYWORD_RX` pattern `/\bfinancing\b/` matches legitimate grants that mention "financing" in context:
- "This grant provides alternatives to traditional financing"
- "Technical assistance and financing options for small businesses"
- "Housing financing assistance program" (which could be a grant for down payment assistance)

Similarly, `/\brepayment\b/` could match "student loan repayment assistance programs" which are themselves grants.

**Impact:** Valid grant opportunities are being silently filtered out as "loan-like."

**Fix:** Make the heuristic more contextual. Instead of standalone word matches, look for loan-indicative combinations:

```js
const LOAN_PHRASE_RX = [
  /\bloan\s+(program|application|forgiveness|repayment)\b/,
  /\bmicroloan\b/,
  /\b(?:apr|annual percentage rate)\b/,
  /\bcredit\s+line\b/,
  /\brevolving\s+credit\b/,
  /interest\s+rate/,
]
```

And exempt grants that mention loans in the context of "loan repayment assistance" or "loan forgiveness."

---

## Issue #6 — MODERATE: "0 Results" Fallback Bypasses Min-Score Slider

**Locations:** Lines 1312–1319 (DB path), 666–672 (live path)

**Problem:** When `min_match_score` filters everything out but scored results exist, the system falls back to returning ALL scored results regardless of the threshold:

```js
if (initiallyIncludedCount === 0 && totalFound > 0) {
  filteredOpportunities = scored
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, 50)
}
```

**Impact:** The user's slider setting is effectively ignored when all results fall below threshold. A user setting min_match_score=80 will still see results scoring 15–30 with no indication that the filter was bypassed. The `debug.db.fallback_applied` flag exists but is not surfaced to the frontend.

**Fix:** Either (a) respect the slider and return 0 results with a diagnostic message, or (b) surface the fallback state to the UI so users understand why low-scoring results appear. Option (b) is better UX — return the results but include a user-facing message like "No results met your threshold of 80%. Showing best available matches."

---

## Issue #7 — MODERATE: Stale source_id Includes Deadline in Hash

**Location:** `opportunityInserter.js` line 30–32

**Problem:** The `stableSourceIdFromOpportunity()` hash includes the deadline:

```js
const raw = `${source}|${url}|${title}|${sponsor}|${deadline}`
return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
```

When the same opportunity gets a deadline update (e.g., extended from "2026-03-31" to "2026-06-30"), this generates a new source_id. The upsert then *inserts a new record* instead of updating the existing one, creating a database duplicate.

**Impact:** DB bloat with near-duplicate records differing only in deadline. Both old and new records remain active.

**Fix:** Remove `deadline` from the hash. The natural key should be `source + url + title + sponsor`:

```js
const raw = `${source}|${url}|${title}|${sponsor}`
```

Or even simpler: for grants.gov results that have stable IDs, use those IDs directly as `source_id`.

---

## Issue #8 — LOW: Module-Level Rejection Counter Shared State

**Location:** `opportunityPolicy.js` lines 22–35

**Problem:** `_rejectionCounts` is a module-level object. While `resetPolicyRejectionCounts()` is called at the start of each request, in a concurrent server environment, two overlapping requests could corrupt each other's counts. Node.js is single-threaded so this doesn't cause race conditions, but the pattern is fragile and semantically incorrect when `Promise.all` runs multiple crawlers in parallel within a single request.

**Impact:** Rejection stats could mix counts from the normalization pass and the post-scoring pass within the comprehensive crawler's parallel execution. Low practical impact since stats are debug-only.

**Fix:** Pass a per-request `rejectionCounts` object through the call chain instead of using module-level state. This is already partially done — `runLiveCrawler` creates its own `rejectionCounts` local, but `enforceOpportunityPolicy` ignores it and uses the module-level counter.

---

## Issue #9 — LOW: COALESCE-Based Updates Never Clear Stale Data

**Location:** `opportunityInserter.js` lines 163–196

**Problem:** The UPDATE uses `COALESCE(?, column)` for every field. This means if a re-crawl legitimately finds that a field should now be `null` (e.g., a deadline was removed, or a sponsor changed), the old stale value is preserved forever because COALESCE picks the non-null existing value.

**Impact:** Stale data persists in the DB indefinitely for fields that were once populated but are no longer present in the source.

**Fix:** For fields that should be updatable to null (like `deadline`, `amount_min`, `amount_max`), use direct assignment instead of COALESCE when the incoming value is from a live crawl:

```js
// Only use COALESCE for fields that should never be null-downgraded
// Use direct set for fields that can legitimately become null
deadline = ?,  // direct for live crawls
amount_min = COALESCE(?, amount_min),  // COALESCE for safety fields
```

---

## Architecture Diagram

```
User Request → POST /run
  │
  ├─ 1. Profile loading (getProfileWithLocation)
  ├─ 2. Facet building (buildProfileFacets, requireFacets)
  ├─ 3. Query planning (planCrawlerQueries)
  │
  ├─ 4. LIVE PATH: runLiveCrawler()
  │     ├─ Individual crawler (or all 7 via comprehensive)
  │     │   └─ Each crawler: grants.gov API → internal dedup → score (crawlerHelpers)
  │     │                                                          ⬆ ISSUE: ECF has no dedup
  │     │                                    ⬆ ISSUE: comprehensive has no cross-crawler dedup
  │     ├─ normalizeLiveOpportunity() → enforceOpportunityPolicy() [1st check]
  │     ├─ isOpportunityCurrent() filter
  │     ├─ calculateMatchScore() via matchingEngine.js → max-merge with crawler score
  │     │                                                  ⬆ ISSUE: dual engines, score inflation
  │     ├─ enforceOpportunityPolicy() [2nd check — redundant]
  │     ├─ min_match_score filter (with fallback bypass)
  │     │                           ⬆ ISSUE: slider bypassed when all below threshold
  │     └─ bulkUpsertFundingOpportunities() → persist to DB
  │                                            ⬆ ISSUE: deadline in hash creates DB dupes
  │
  ├─ 5. DB FALLBACK PATH (if live < MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK):
  │     ├─ buildCandidateOpportunityQuery() [SQL exclusions for loans/match]
  │     ├─ formatDbOpportunity() → enforceOpportunityPolicy() [3rd check]
  │     ├─ calculateMatchScore() via matchingEngine.js
  │     ├─ enforceOpportunityPolicy() [4th check — redundant]
  │     └─ min_match_score filter (with fallback bypass)
  │
  └─ 6. MERGE: live + DB → dedup by URL/title → .slice(0, 50) → response
```

---

## Priority Recommendations

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | #1 Cross-crawler dedup in comprehensive mode | Small (5 lines) | Eliminates most visible duplicates |
| **P0** | #2 Consolidate scoring to single engine | Medium (refactor) | Consistent, predictable scores |
| **P1** | #3 ECF crawler dedup | Small (10 lines) | Eliminates ECF duplicates |
| **P1** | #5 Loan keyword false positives | Small (regex update) | Recovers filtered valid grants |
| **P1** | #7 Remove deadline from source_id hash | Small (1 line) | Prevents DB duplicates |
| **P2** | #6 Surface slider fallback to UI | Small (frontend change) | Better UX transparency |
| **P2** | #9 COALESCE never clears stale data | Medium (conditional logic) | Fresher DB data |
| **P3** | #4 Triple policy enforcement stats | Small (counter scoping) | Accurate debug stats |
| **P3** | #8 Module-level shared state | Small (pass-through) | Cleaner architecture |
