# Crawler Policy Proof — Non-Negotiable Exclusions & Enforcement

This document describes how GrantFlow enforces non-negotiable business rules across all real crawlers (everything except GeoCrawler) so that only **real, relatable** funding sources with valid URLs are returned, and loans, matching-funds, and placeholders never appear.

> **Executable proof:** every guarantee below is locked down by
> `tests/unit/crawler-policy-proof.test.mjs`. If the prose and the tests
> disagree, trust the tests. Run them with:
>
> ```bash
> node --test tests/unit/crawler-policy-proof.test.mjs
> ```

## What Changed

1. **Centralised policy** — `backend/services/shared/opportunityPolicy.js` is the single source of truth:
   - `isValidRealUrl(url)` — strict http/https only; rejects example.com, localhost, placeholder domains.
   - `isPlaceholderOpportunity(opp)` — detects lorem, “coming soon”, stub text, missing/short title.
   - `isLoanLike(opp)` — `opportunity_type` in [loan, loan_program, microloan] + keyword heuristics (loan, financing, APR, repayment, etc.).
   - `isMatchingFunds(opp)` — `requires_match === true`, `match_percentage > 0`, and keyword heuristics (matching funds, cost-share, 1:1 match, dollar-for-dollar).
   - `enforceOpportunityPolicy(opp)` — returns `{ ok, reason }`; bumps rejection counters for debugging.
   - `filterByPolicy(opportunities, opts)` — filters an array and merges rejection counts into `opts.rejectionCounts`.

2. **Policy applied in every path**
   - **Live crawler normalization** — `normalizeLiveOpportunity()` in `realCrawlers.js` calls `enforceOpportunityPolicy(raw)` first; non-compliant rows return `null`.
   - **After rescoring** — Live path applies `filterByPolicy` after rescoring and again before threshold; DB fallback applies `enforceOpportunityPolicy` in `formatDbOpportunity()` and after scoring.
   - **DB candidate query** — `buildCandidateOpportunityQuery()` hard-excludes:
     - `opportunity_type` IN (loan, loan_program, microloan)
     - `is_loan = TRUE` (when column exists)
     - `requires_match = TRUE`
     - `match_percentage > 0`
     - Dialect-safe for SQLite and Postgres.
   - **Before persistence** — `bulkUpsertFundingOpportunities()` in `opportunityInserter.js` runs `enforceOpportunityPolicy(opportunity)` on each item; only compliant opportunities are written.

3. **Local crawler**
   - **25-mile anchors** — Anchor list = profile ZIP + interested-school ZIPs from `extractInterestedSchoolZips()`. Radius is fixed at 25 miles (`DEFAULT_SEARCH_RADIUS_MILES`). When there is no ZIP or no anchors, only policy-compliant directory resources are returned (no radius matching).
   - Policy is applied to every opportunity before scoring and before adding to results.

4. **Student crawler**
   - **FAFSA** — `extractFafsaSignals(profile, signals)` returns pellEligible, highNeed, lowIncome, dependencyStatus, SAI/EFC. Used to include/weight federal and need-based programs.
   - **School-specific** — For schools in `university_applications` and `education.interested_schools`, uses `getSchoolFinAidUrl(school)` and `generateSchoolFinAidUrl(school)` (deterministic patterns, no auth). All outputs pass `enforceOpportunityPolicy`.
   - **calculateMatchScore** — All calls use (profileContext, opportunity) with profile first.

5. **Debug**
   - Rejection reasons are accumulated in `validation_rejection_counts` and `policy_rejections_db` in the run response debug object.
   - `scripts/check-crawler-results.mjs --response <path-to-json>` prints returned count, policy rejection counts, and top rejection reasons from a saved crawler response.

6. **Analysis-driven fixes (CRAWLER_ANALYSIS.md)**
   - **Cross-crawler dedup** — In comprehensive mode, after `results.flat()`, results are deduplicated by URL/title so the same opportunity is not returned by multiple sub-crawlers.
   - **Single scoring engine** — The route layer uses only `matchingEngine.calculateMatchScore(profileContext, row)` for the final score; crawler-provided scores are no longer max-merged, so the slider reflects one consistent algorithm.
   - **ECF crawler dedup** — `crawlECFBenefits()` uses a `seenUrls` Set so the same ECF benefit is not returned multiple times from different sources.
   - **Loan keyword false positives** — `isLoanLike()` uses phrase-based patterns (e.g. loan program, loan fund, repayment of loan) and exempts grant contexts (loan repayment assistance, loan forgiveness, alternatives to financing, down payment assistance) so valid grants are not filtered out.
   - **Stable source_id** — `stableSourceIdFromOpportunity()` no longer includes deadline in the hash, so deadline-only updates (e.g. extensions) update the same record instead of creating duplicates.

7. **Additional fixes (#4, #6, #8, #9)**
   - **#4 Triple policy** — Removed redundant policy pass: live path no longer runs `filterByPolicy(normalized)` after normalization (normalization already applies policy), and after rescoring only one `.filter(enforceOpportunityPolicy)` is used (no second `filterByPolicy(rescored)`), so rejection counts are not double-counted.
   - **#6 Slider fallback message** — When all results are below `min_match_score` and the guardrail returns “best available” results, the API now includes `threshold_fallback_message`: e.g. `"No results met your threshold of 80%. Showing best available matches."` so the UI can show it. Included in both live-only and merged responses when fallback is applied.
   - **#8 Per-request rejection counts** — `enforceOpportunityPolicy(opp, opts)` accepts optional `opts.rejectionCounts`. When provided, rejections are written to that object instead of the module-level counter. The route passes a request-scoped `rejectionCounts` / `dbRejectionCounts` so concurrent requests and parallel crawlers do not mix stats. `filterByPolicy` uses the same optional object and no longer calls `resetPolicyRejectionCounts()`.
   - **#9 COALESCE and stale data** — For updates with `record_origin === 'live_crawl'`, nullable fields `description`, `amount_min`, `amount_max`, `amount_description`, `deadline`, and `deadline_type` are set with direct assignment (`?`) instead of `COALESCE(?, column)`, so re-crawls can clear stale values when the source no longer has them.

## How to Run the Tests

```bash
# Executable guarantees for THIS document — one test per prose bullet
node --test tests/unit/crawler-policy-proof.test.mjs

# Unit tests for opportunityPolicy (rejects loans, matching funds, placeholders, requires valid http(s))
node --test tests/unit/opportunityPolicy.test.mjs

# Integration-style tests: DB fallback excludes loan, matching_funds, missing URL; min_match_score enforced
node --test tests/unit/real-crawlers-policy.test.mjs
```

## How to Run the Debug Script

```bash
# Default: DB summary (opportunities, jobs, pipeline)
node scripts/check-crawler-results.mjs

# From a saved crawler response JSON (e.g. after POST /api/real-crawlers/run)
node scripts/check-crawler-results.mjs --response /path/to/response.json
```

## Summary Table

| Path | Where policy is enforced |
|------|---------------------------|
| Live normalization | `normalizeLiveOpportunity()` → `enforceOpportunityPolicy(raw)` (imported from `backend/services/shared/opportunityPolicy.js`) |
| Live after rescoring | `filterByPolicy` + `.filter(enforceOpportunityPolicy)` |
| DB candidate query | `buildCandidateOpportunityQuery()` SQL conditions (loans, requires_match, match_percentage, is_loan) |
| DB format | `formatDbOpportunity()` → `enforceOpportunityPolicy(formatted)` |
| DB after scoring | `enforceOpportunityPolicy` in filter and `getPolicyRejectionCounts()` for debug |
| Persistence | `bulkUpsertFundingOpportunities()` → `enforceOpportunityPolicy(opportunity)` before each upsert |
| Local crawler | `enforceOpportunityPolicy(opp)` before scoring and before push to results |
| Student crawler | `enforceOpportunityPolicy` on federal aid, signal-specific, school-specific, and live opps |
