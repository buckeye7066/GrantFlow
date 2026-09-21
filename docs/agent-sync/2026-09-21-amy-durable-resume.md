# Amy durable run recovery

Amy's long-running synthetic cohort previously lost completed evaluations on process restart. Each replacement process planned another full cohort before adopting orphan profiles, preventing stale execution evidence from recovering under repeated releases and provider delays.

A scheduler-lease-owned checkpoint now persists the immutable plan, resolved options, synthetic member IDs, and each completed evaluation. Restart resumes unfinished members under the same logical run. Assigned IDs can repair interrupted synthetic creation only when run/member ownership matches. Policy changes invalidate obsolete evaluations and replace the same run's flywheel receipt without counting it twice.

Teaching includes adopted profiles' own findings. Checkpoints remain pending when teaching, report persistence, or cleanup fails. Retry after successful deletion skips metadata writes for deleted profiles while retaining their cached teaching evidence. Status adds running_progress; incomplete completion remains an explicit runner error and freshness retry.

Verified: Amy family 402 tests passed; six explicit checkpoint tests passed; real local PostgreSQL checkpoint concurrency/reconnect test passed; full prepush checks passed. Independent review found and drove regressions for configuration drift, unreadable cleanup, stale policy receipts, and foreign-key failure after cleanup. No paid inference or external messages were used in validation.

Run PostgreSQL validation with GRANTFLOW_AMY_TEST_DATABASE_URL pointing to a disposable localhost database and `node --test tests/integration/amy-checkpoint-postgres.test.mjs`.

Production freshness and provider capacity are not established by these tests. Preserve the stale finding until an isolated completed receipt exists. This repair does not claim to restore exhausted hosted-model credits or sustained local extraction capacity.
