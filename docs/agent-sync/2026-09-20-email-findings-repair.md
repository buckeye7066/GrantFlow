# Email finding evidence repair checkpoint

Goal: preserve specific diagnostic advice and investigation references without concealing failures.
Base: ac30991cfcde77e1e3cfe2e4be909758951a165a. PR: #1772.
Scope: reporting only. No provider routing, eligibility, amount census or production-data changes.
Workspace: independent clone; original shared checkout and its edit lock remain untouched.

## Implemented
- [x] Display the finding's recommended_fix, with the existing category fallback.
- [x] Preserve explicitly provided affected files and routes on INTERNAL failures.
- [x] Carry registered investigation_files separately in evidence, including thrown checks.
- [x] Show investigation references in summaries without converting them to planned edit targets or rollback paths.
- [x] Keep attempted-but-unanswered amount findings red without asserting a proven JS shell or mandatory API adapter.

## Executed verification
- First regression run: 8 failed, 1 passed before the initial source repair.
- Initial final focused run: 96 tests passed across six files.
- Review regression run reproduced lost thrown-check references and investigation/edit-target conflation.
- After reference corrections: 98 tests passed across the same six files.
- git diff --check passed. Required hosted release checks and deployment still require final verification.

## Unresolved and not represented as repaired
- A tool safety check blocked the attempted durable per-row amount-reason enrichment edit before execution; it was not retried via another path.
- Two newly written failing tests for that unimplemented enrichment are preserved outside the active suite in Home's grantflow-amount-reason-regression-pending-20260920.test.js. They are not claimed as passing or as part of the implemented reference repair.
- Review discussion #4057749496 remains open. The bounded failure ring is not complete historical per-row evidence.
- Live extractor timeouts/quota failures, cohort acceptance, and the two actual missing amount answers are not resolved by these reporting changes.
- No production-readiness or deployment claim. Do not repeat implemented repairs; continue from the explicit unresolved evidence.
