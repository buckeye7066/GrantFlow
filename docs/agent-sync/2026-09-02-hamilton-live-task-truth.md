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

“Real” requires a positive link status backed by a verification timestamp no
older than 30 days. If the profile evidence or canonical evaluator is
unavailable, writers return 503 and reconciliation reports failure without
cancelling, deleting, or tombstoning durable work.

## Reconciliation behavior

- Every unfinished task is audited without a post-LIMIT blind spot.
- Invalid work is cancelled and auto-submit intent is disabled.
- Persisted profile/opportunity match truth is removed.
- Early grant rows are tombstoned and removed; opportunity-only tasks receive a
  profile-scoped tombstone. Protected submission history is never rewritten.
- Pointer/search/directory surfaces are discovery leads even when they carry a
  URL; they cannot become leaf application tasks.
- A policy-refused missing-info stop is cancelled instead of remaining in the
  owner’s “needs you” queue.

Migration `1001_live_hamilton_task_truth.mjs` runs the fleet cleanup in both
database dialects without embedding private profile identifiers in source. The
deployment verification then opens the incident profile's authenticated task
endpoint, which reruns the same enforced audit for that exact profile. The
existing `pipeline_precision` boot step also reruns the unfinished-task audit
on every boot and fails loud if it is unreadable, unrepaired, or truncated.

## Product surface

`GET /api/hamilton/automation/tasks` now returns explicit unfinished `current`
and terminal `history` collections, plus total bucket counts. Its legacy
complete `tasks` collection remains for calendar/pipeline compatibility. The
queue, watch window, and triage page consume the explicit partition without
presenting finished history as current work.

## Verification contract

Do not close #1475 from a health check alone. Required proof remains:

- required checks green on the focused PR,
- exact merged main SHA deployed on Railway and Vercel,
- `/api/version.pipeline_precision` healthy with the boot-verified exact
  evaluator reporting zero invalid unfinished Hamilton tasks,
- a fresh authenticated capture of the named profile, and
- a post-deploy crawler/agent cycle with no re-created invalid work.
