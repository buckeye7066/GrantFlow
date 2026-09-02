# Hamilton live task truth — 2026-09-02

Issue: #1475. Production-readiness blocker for the incident profile.

## Invariant

An unfinished Hamilton task exists only while its current funding source:

1. receives a freshly computed canonical `ACCEPT` (a stored ACCEPT is evidence,
   never permission),
2. is a real, directly actionable leaf source,
3. is relatable to the profile,
4. positively covers at least one structured declared need, and
5. positively qualifies the profile, including explicit applicant type.

`assessHamiltonFundingSource()` is the choke point. Task creation, the strict
reconciliation, the boot `pipeline_precision` net, and ready-source selection
all consume it. The boot net persists a post-repair numeric census for the
public `/api/version` readiness metric, so health polling never reruns the full
evaluator.

"Real" requires a positive link status backed by a verification timestamp no
older than 30 days. An older positive result is deferred for re-verification;
age alone is not negative evidence. If the profile evidence, link verifier, or
canonical evaluator is unavailable, writers return 503 and reconciliation
preserves durable work rather than cancelling, deleting, or tombstoning it.

## Reconciliation behavior

- Every unfinished task is audited without a post-LIMIT blind spot.
- Invalid work is cancelled and auto-submit intent is disabled.
- Persisted profile/opportunity match truth is removed.
- Early grant rows are tombstoned and removed; opportunity-only tasks receive a
  profile-scoped tombstone. Protected submission history is never rewritten.
- Submission-uncertain states preserve the task, grant, match, and traces for
  human verification even when the current funding policy cannot pass.
- Pointer/search/directory surfaces are discovery leads even when they carry a
  URL; they cannot become leaf application tasks.
- A policy-refused missing-info stop is cancelled instead of remaining in the
  owner’s “needs you” queue.

Migration `1001_live_hamilton_task_truth.mjs` runs the fleet cleanup in both
database dialects without embedding private profile identifiers in source. The
deployment verification then opens the incident profile's authenticated task
endpoint, which consumes the last complete boot census without mutating data on
each UI poll. The `pipeline_precision` boot step invalidates the prior snapshot,
runs repair and an independent read-back audit on every boot, then publishes the
`numeric_boot_verified_task_truth_v4` contract. It stays unhealthy if either
pass is unreadable, unrepaired, deferred, or truncated. A retryable stale-link
deferment can leave the existing queue readable while every writer remains
closed until fresh evidence is available. After the serialized recurring link
verifier refreshes liveness, `refreshHamiltonTaskTruthAfterLinkVerification()`
repairs and reads back unfinished tasks and may advance only an already-readable
boot snapshot. A missing, failed, or truncated boot census can never be turned
green by that background refresh.

## Product surface

`GET /api/hamilton/automation/tasks` now filters unfinished `current` work in
SQL before any limit, so newer terminal history cannot hide an old active row.
It returns a bounded recent `history` page, exact total bucket counts, and a
rolling-deploy `tasks` compatibility union containing every current row plus
that history page. Queue/watch surfaces display the exact history total and say
when only the newest outcomes are shown. The response includes only the numeric
cached task-truth summary; it never exposes profile or task identity in the
public readiness surface.

## Verification contract

Do not close #1475 from a health check alone. Required proof remains:

- required checks green on the focused PR,
- exact merged main SHA deployed on Railway and Vercel,
- `/api/version.pipeline_precision` healthy with the boot-verified exact
  evaluator reporting zero invalid unfinished Hamilton tasks,
- a fresh authenticated capture of the named profile, and
- a post-deploy crawler/agent cycle with no re-created invalid work.
