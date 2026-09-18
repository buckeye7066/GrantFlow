# Recurring stored-match refresh and durable progress

Reconciles PR #1749 with main ec9b9cc6491b2b0e74ff2217697bc8b69440c290 / PR #1750. All newer exact-backlog verification and runner fixtures are preserved.

The existing leased link-verification callback resumes one bounded batch after boot and link repair, before task-truth maintenance. No new timer, change to the 800-pair/45-second defaults, admission policy, proof history, application history, or source deletion. Cancellation stops new work and writes.

Recurring work stores a running receipt before starting and a conditional terminal receipt under system_kv.stale_match_explain_last_run. A cancelled lease leaves an incomplete running record, and an old attempt cannot overwrite a newer one. Receipts carry aggregate diagnostics only. Sam's existing invariant check overlays a newer recurring result in memory, preserves historical boot records and unrelated failures, and refuses missing, stale, pending, disabled, malformed or failed progress as proof of completion.

Tests cover real SQLite batches and durable readback, cancellation, conditional publication, current/old/stale receipt precedence, Sam consumption, and the actual scheduling function. Exact-baseline red/green runs and existing PR #1750 tests are required before publication. Full exact-head CI and production readback remain release gates. No new funding/application outcome is claimed. Phases 3-5 remain open.
