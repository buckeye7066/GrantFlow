# September 22 daily report: funding evidence and live blockers

## Change in this branch

The report's Field Assistance Bulletin title and a synthetic assistance-directory fixture both reproduced false direct-funding benchmark candidates. The benchmark now consumes affirmative exclusions from the canonical funding-result classifier on both sides of the comparison. Numbered Field Assistance Bulletins join the existing canonical procedural-notice rule and its SQL candidate superset. Actual award pages on the same host remain eligible; absent structured fields in a search snippet are not treated as a rejection.

Known non-funding catalog rows cannot manufacture overlap or GrantFlow-only coverage. Historical candidate records remain intact. Benchmark semantics advance from 4 to 5 so a changed denominator is not reported as a genuine crawler improvement against old scores. No score floor, applicant eligibility rule, provider budget, scheduler lock, or production data was relaxed or cleared.

## Verification

- Baseline: 65 tests passed in webParityBenchmark and amyFlywheelCohort.
- New regression file: 6 failing assertions and 3 passing counterweights before the fix; all 9 pass after the fix.
- Focused verification: 286 tests pass across webParityFundingEvidence, webParityBenchmark, webParityRelevanceRegression, webParityDispositions, and fundingResultFilters.
- Full `npm test` was started; completion is not yet established in this note. Log: `C:\Codex-Workspace\.codex-tmp\grantflow-report-20260922\full-test.log`.

## Production evidence, not fixed by this branch

Railway deployment `faf4cce1-10c3-41bb-b361-7a5511122e9b` runs main `be2e8bed058da55c5c3521a6423d709ac609d090`. Logs at 2026-09-22T16:50:39Z show Amy's six-hour attempt ending with `Job time budget exhausted`, immediately followed by checkpoint resumption under its existing lock. Successful owner-subscription completions and continued checkpoint progress coexist with extraction quota/timeouts. A running scheduler is not a fresh completed cohort or restored discovery coverage. No duplicate Amy run was started and no active lease was cleared.

Production also logged `crawler grants` queries and repeated Wikipedia Web_crawler extraction failures. PR #1808 already addresses operational tags contaminating discovery/scoring; inspect and integrate that existing fix rather than duplicating it. PR #1809 addresses page deadlines and accepted-match preservation during partial discovery. Both are stacked on earlier pending work and are not deployed.

GitHub check-run 106574489110 explicitly reports: `The job was not started because your account is locked due to a billing issue.` Required test/test-suite checks must actually execute and pass before merge. No fabricated check, administrative merge, deployment bypass, or payment/account change was performed.

The report's individual real crawler-job error has not been resolved to its exact database record. The local Railway CLI reports Unauthorized; connected Railway log inspection works, but does not substitute for that diagnostic record. Do not assert that the separate Amy timeout is that one crawler-job failure.
