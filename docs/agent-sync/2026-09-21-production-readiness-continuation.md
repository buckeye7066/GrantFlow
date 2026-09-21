# Production readiness continuation

Owner goal: make GrantFlow production ready, preserving all work and delivering fixes through GitHub main. The September 21 retirement of the exact-50 acceptance runner supersedes the September 20 audit closure note; do not revive that retired gate or describe its removal as a pass.

## CHANGED

`opportunityMatcher` deliberately refuses non-fundable records with `not_a_grant:*`. `pipelinePromotion.classifyOutcome` previously treated that documented refusal as an unknown transient error. The promotion writer now records it as `live_reject`, preserving the exact reason. This removes unchanged reference records from retry work and the remaining-work count. Before candidate selection, the same service repairs only live error receipts carrying that exact reason prefix. It preserves timestamps, attempts and admission fingerprints, so actual errors remain retryable and changed records can still be reconsidered by the existing fingerprint policy. Eligibility, match scores and pipeline admission rules are unchanged.

The chain is admission refusal -> durable promotion outcome -> candidate eligibility/remaining count -> outcome summary. Existing summary consumers already support live_reject; no new response shape or database column is introduced. Regression coverage exercises rejection, no repeat attempt, remaining count and repair of a legacy receipt.

## VERIFIED

The deployed frontend and backend were rechecked at f3df4189544665e45d23bce0d39ff4c8437bf3c6 before this continuation. The earlier owner-session audit proved Account loading, calendar export, targeted Grants.gov receipt persistence (69 found, nine accepted, no source failures), and logout. Those checks do not establish exhaustive application readiness.

A focused execution of the actual classifier source reproduced `not_a_grant:past_award_intel -> error`. The corrected source passed checks for historical/reference refusals, genuine transient errors, unknown reasons, explicit rejection and duplicate races. Database integration and full release evidence must come from the PR checks before merge.

## UNKNOWN / remaining gates

Local endpoint and promotion suites encountered a Windows native memory failure (`Releasing the double mapped memory failed`) and did not yield a valid test result. The host then stopped responding promptly to test-process termination. GitHub's connector preserved the regression and repair on the PR branch so CI can run independently. The original local regression edit must be reconciled with that committed branch once the host responds; no edits may be discarded.

Production's 24-hour health history still contains the earlier discovery timeout. A complete post-fix multi-source crawl, production provider-dependent AI paths, email delivery, real payment processing and actual external submissions are not certified by the targeted crawl, mocks, navigation checks or successful builds. External-message and financial actions require their applicable authorization; do not invent receipts or silently substitute fixture success for live success.
