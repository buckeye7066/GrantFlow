# Amy durable resume implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Preserve one logical Amy training run across process restarts without duplicating synthetic profiles or claiming uncompleted work.

**Architecture:** A single durable checkpoint in system_kv is owned by the existing scheduler lease. It records the immutable scenario plan, effective serializable options, assigned profile IDs, and completed evaluations. The runner resumes it before creating another cohort. Writes fail closed; teaching and report persistence remain completion requirements.

**Tech Stack:** Node ESM, existing SQL adapter (PostgreSQL/SQLite), Vitest.

**Spec:** The owner's September 21 stale-Amy report and the restart-loss investigation recorded below.

## Global constraints

- Work only on GrantFlow; preserve real profiles and canonical gates.
- Do not change cohort targets to manufacture freshness.
- Preserve scheduler exclusion and cancellation; no reset of a live lease.
- No paid inference in tests; use injected discovery and real SQLite persistence.
- Never mark a profile taught unless its findings participated in teaching.

## Review focus

- Crash after profile insertion but before member receipt: reuse the assigned ID and finish initialization.
- Crash after one evaluation: reuse it and crawl only unfinished members.
- Storage failure or concurrent replacement: fail closed, retain the checkpoint.
- Teaching/report failure: do not clear resume evidence or claim completion.
- Policy version changes: keep the same profiles/plan but remeasure obsolete evaluations.

## Task 1: Durable checkpoint and recoverable creation

Files: create `backend/services/amy/amyRunCheckpoint.js`, tests `backend/tests/amyRunCheckpoint.test.js`; modify `amyProfileStore.js` with an optional preassigned synthetic ID and ownership checks.

- [x] Write failing SQLite tests for resume, compare-and-swap writes, corrupt state, and recoverable creation.
- [x] Implement strict checkpoint reads/writes and guarded reuse of a profile belonging to the same run/member.
- [x] Run tests and verify unrelated profiles cannot be overwritten.

## Task 2: Resume orchestration and teaching evidence

Files: `amyRunner.js`, `amyAgent.js`, `backend/tests/amyAgent.test.js`, new restart regressions as appropriate.

- [x] Write interruption regressions at creation and evaluation boundaries.
- [x] Load checkpoint under the scheduler lease, preserve effective configuration and run identity, persist the plan before profile creation and each completed member afterward.
- [x] Keep incomplete checkpoints on teaching/report failure; clear only after durable completion.
- [x] Include orphan findings in their actual teaching receipt while keeping planned cohort accounting separate.
- [x] Run Amy regression family and inspect status/report consumers.

## Task 3: Review and release

- [x] Independent branch review; resolve findings.
- [x] Full pre-push checks and relevant PostgreSQL validation.
- [ ] PR and required CI; guarded merge only after checks pass.
- [ ] Verify deployment, resumed-run status, live relevance refresh, and current diagnostics. Do not equate active training with fresh completed evidence.

## Execution ledger

Investigation: completed evaluations currently exist only in memory; orphan adoption runs after the new planned cohort. No durable resume path exists. Orphan evaluations are reported separately but currently inherit a teaching receipt derived only from planned evaluations. Current live latency also reflects unavailable hosted providers and intermittent local-model failures; checkpointing does not claim to solve inference capacity.

Ruling: continue implementation inline under the owner's standing request to finish GrantFlow. Existing authorization covers branch/PR/guarded-release work; no new permission pause is needed.
