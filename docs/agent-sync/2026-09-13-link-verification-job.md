# Link verification recovery implementation plan

> Execute the tests and implementation in this isolated worktree; do not replace other workers' local changes.

**Goal:** Make the existing manual verifier finish without holding an HTTP request open or overlapping the scheduled verifier.
**Architecture:** An admin-only asynchronous job uses the existing `scheduler:link-verification` lease and canonical `runLinkVerification`. A bounded `system_kv` record exposes the latest run across replicas and restarts. It never creates link proof without the canonical network probe.
**Tech stack:** Existing Express, Node, PostgreSQL/SQLite adapter, scheduler lease, and Vitest. No new dependencies.
**Spec:** The production request to finish GrantFlow and the measured timeout described below.

## Evidence and constraints

- PR #1682 merged as `c2cb9730093d5f667f3cca8c4397d61ebaf9d33b`; both deployed release identities match.
- A manual 200-row verification request returned HTTP 504. The audit ledger subsequently recorded all 200 real probes. Repeating after the timeout can therefore overlap work.
- At 2026-09-13T13:22Z, visible direct opportunities were 18,338/18,338 freshly verified; the complete visible catalog was 23,831/26,663 (89.4%, required 95%). No threshold may be lowered.
- Keep the existing two-probe batch and two-second delay. No catalog deletion, invented verification, real grant submission, provider-credit purchase, or unrelated app changes.

## Implementation and verification

1. Add `backend/tests/adminLinkVerificationJob.test.js` with pending-worker, authorization, validation, contention, persistence, interruption, error-redaction, and bounded-batch cases. Run `node scripts/run-vitest-isolated.mjs run backend/tests/adminLinkVerificationJob.test.js`; the initial run must fail because the job router is absent.
2. Add `backend/routes/adminLinkVerification.js`. `POST /api/admin/verify-links` returns 202 only after lease acquisition and durable running-state storage. `GET /api/admin/verify-links/status` exposes the latest sanitized run. Contention is 409, unavailable persistence is 503, and restart/lease loss is interrupted rather than completed.
3. Mount the router through the existing admin authorization checks. Add cancellation checkpoints to `runLinkVerification`; share the same scheduler lease with recurring and weekly callers. Keep all link verdicts and network pacing unchanged.
4. Permit an integer `max_batches` from 1 through 10, default 1; each batch is the existing 200-row canonical pass. Persist aggregate progress between passes and stop when no candidates remain. Bound the overall run to one hour.
5. Run the new tests, related link/scheduler tests, lint, type checking, production build, and repository gates. Obtain review and passing CI on the exact head, then merge through `scripts/codex-merge-pr.sh`.
6. Verify the deployed identity, the 202/status/completion contract, actual catalog progress, and `/readyz`. Record unknown or blocked product outcomes without claiming production readiness from a build alone.

## Result

Implementation and live verification are not yet complete. This note records the current plan and measured baseline, not a completion claim.

## Operator contract

`POST /api/admin/verify-links` accepts `{}` or `{"max_batches": 1}` through `{"max_batches": 10}`. Each pass checks at most 200 candidates through the unchanged canonical verifier and source pacing. The response is HTTP 202 after durable admission, with `run_id` and `status_url`; it is not a claim that verification finished.

Poll the admin-authenticated `GET /api/admin/verify-links/status`. Its `run` is the latest manual run, with `status`, `batches_completed`, `stats`, and timestamps. Match `run_id` before attributing results to a request. Terminal states are `completed`, `failed`, or `interrupted`. `completed` means the requested bounded passes finished, not that the production mission gate passed. A missing/expired worker lease is reported as interrupted rather than permanently running.

HTTP 409 means another manual, recurring, weekly, or repair verifier holds the shared scheduler lease. No duplicate pass was launched. HTTP 503 means admission/status persistence was unavailable. The job stores only bounded aggregate statistics, never provider keys, fetched page content, or raw error payloads. Repeated calls cannot overwrite a newer run's record while an older worker settles.

Local verification before publication: 17 job-contract tests and 45 related verifier/lifecycle/scheduler tests pass (62 total); changed-file ESLint passes with zero warnings. Both new cancellation tests failed against the prior verifier before the checkpoints were added. Full repository checks and post-deployment evidence remain separate gates.
