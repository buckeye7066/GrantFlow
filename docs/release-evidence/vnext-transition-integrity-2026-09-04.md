# VNext transition and guidance integrity release evidence

Date: 2026-09-04
Release line: `fix/vnext-transition-integrity-current-main-20260904`

## Production controls in this revision

- Application guidance may move between deduplicated rows only when durable opportunity identity agrees. A shared portal URL or similar display text is insufficient, and explicit funder disagreement blocks the fuzzy fallback.
- Same-state transition retries are bound to the exact `state` and `stage` snapshot that authorized their side effects. A concurrent lifecycle change makes the no-op compare-and-swap fail and rolls the transaction back.
- Boundary repair uses the same snapshot discipline and also compares the prior boundary fields.
- The transition path continues to run scoring, drafting-task, invariant, and audit work inside the transaction before returning success.

## Release rule

This document records the controls being verified; it is not a substitute for execution. The revision may be merged only after the repository’s complete exact-head workflow set succeeds. The merge commit on `main` is the only release identity.

After merge, this line supersedes the overlapping stale work in PRs #1509 and #1514.
