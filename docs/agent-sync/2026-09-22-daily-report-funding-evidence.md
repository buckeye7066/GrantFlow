# September 22 daily report: funding evidence and live blockers

## Change in this branch

The report's Field Assistance Bulletin title and a synthetic assistance-directory fixture both reproduced false direct-funding benchmark candidates. The benchmark now consumes affirmative exclusions from the canonical funding-result classifier on both sides of the comparison. Numbered Field Assistance Bulletins join the existing canonical procedural-notice rule and its SQL candidate superset. Actual award pages on the same host remain eligible; absent structured fields in a search snippet are not treated as a rejection.

Known non-funding catalog rows cannot manufacture overlap or GrantFlow-only coverage. Historical candidate records remain intact. Benchmark semantics advance from 4 to 5 so a changed denominator is not reported as a genuine crawler improvement against old scores. No score floor, applicant eligibility rule, provider budget, scheduler lock, or production data was relaxed or cleared.

## Verification

- Baseline: 65 tests passed in webParityBenchmark and amyFlywheelCohort.
- New regression file: 6 failing assertions and 3 passing counterweights before the fix; all 9 pass after the fix.
- Focused verification: 286 tests pass across webParityFundingEvidence, webParityBenchmark, webParityRelevanceRegression, webParityDispositions, and fundingResultFilters.
- Full `npm test` finished with exit 1. Metadata audit, lint, type checking and the production build passed. The Node unit stage completed 3,424 tests: 3,422 passed and 2 failed, with none skipped or cancelled. Later chained stages did not run after that failure. Log: `C:\Codex-Workspace\.codex-tmp\grantflow-report-20260922\full-test.log`.
- Both failures are in unchanged `tests/unit/autoPopulateGeneration.test.mjs`: the parallel-fan-out test at line 91 measured 754ms against its 600ms limit; the wall-clock abort test at line 228 completed only 1 of 6 non-hung sections. An isolated rerun also failed both (3 passed, 2 failed). These are unresolved failures, not dismissed as flaky or hidden by increasing test limits.
- Fix pushed as PR #1812, initial code commit `191e1c923ea67d622b5090b4abc460494bcd62ed`. Current PR test check 106871686499 independently confirms the same account billing lock. No merge or deployment has occurred.

## Production evidence, not fixed by this branch

Railway deployment `faf4cce1-10c3-41bb-b361-7a5511122e9b` runs main `be2e8bed058da55c5c3521a6423d709ac609d090`. Logs at 2026-09-22T16:50:39Z show Amy's six-hour attempt ending with `Job time budget exhausted`, immediately followed by checkpoint resumption under its existing lock. Successful owner-subscription completions and continued checkpoint progress coexist with extraction quota/timeouts. A running scheduler is not a fresh completed cohort or restored discovery coverage. No duplicate Amy run was started and no active lease was cleared.

Production also logged `crawler grants` queries and repeated Wikipedia Web_crawler extraction failures. PR #1808 already addresses operational tags contaminating discovery/scoring; inspect and integrate that existing fix rather than duplicating it. PR #1809 addresses page deadlines and accepted-match preservation during partial discovery. Both are stacked on earlier pending work and are not deployed.

GitHub check-run 106574489110 explicitly reports: `The job was not started because your account is locked due to a billing issue.` Required test/test-suite checks must actually execute and pass before merge. No fabricated check, administrative merge, deployment bypass, or payment/account change was performed.

The report's individual real crawler-job error has not been resolved to its exact database record. The local Railway CLI reports Unauthorized; connected Railway log inspection works, but does not substitute for that diagnostic record. Do not assert that the separate Amy timeout is that one crawler-job failure.
