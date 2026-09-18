# Recurring stored-match refresh and durable progress

Reconciles PR #1749 with main ec9b9cc6491b2b0e74ff2217697bc8b69440c290 / PR #1750. All newer exact-backlog verification and the healthy 70-step runner fixture are preserved.

The existing leased link-verification callback resumes one bounded batch after boot and link repair, before task-truth maintenance. No new timer, change to the 800-pair/45-second defaults, admission policy, proof history, application history, or source deletion. Cancellation stops new work and subsequent writes; an already in-flight database write cannot be retroactively cancelled.

Recurring work stores a running receipt before starting and a conditional terminal receipt under system_kv.stale_match_explain_last_run. A cancelled lease leaves an incomplete running record, and an old attempt cannot overwrite a newer one. Receipts carry aggregate diagnostics only. Sam's existing invariant check overlays a newer recurring result in memory, preserves historical boot records and unrelated failures, and refuses stale, pending, disabled, malformed or failed progress as proof of completion.

## Verified implementation checkpoint

GitHub Actions run 35321336644, job 105524282422, checked the exact unchanged main implementation first. The new scheduling/receipt assertions reproduced 17 failures with 3 controls passing. After the bounded repair, all 358 targeted Vitest cases across seven suites and all 27 existing Node budget/verification cases passed. Full lint, typecheck, crawler architecture lint, safe-SQL guard and unchanged signal-fingerprint check also passed. The runner published tested source as 86a557e7c18c71fc205320be941126467dcb1f55 and verified the remote branch.

Tests cover real SQLite batches and durable readback, cancellation before access/during profile loading/after an in-flight write, conditional publication, current/old/stale receipt precedence, Sam consumption, and the actual scheduling function. Existing proof-preservation, incomplete-audit, malformed-data, disabled-work, and query-failure controls remain intact.

The one-use repair workflow and templates have been removed from the release tree; they are not a permanent production component. Full exact-head CI, review, merge and exact-revision production readback remain release gates at this checkpoint. Home remains disconnected, so local synchronization is not claimed. No cleared production backlog or new funding/application outcome is claimed. Phases 3-5 remain open.

## Lease fencing and unavailable boot evidence

Receipt claims and terminal writes require the real scheduler owner token and unexpired database lease in the same conditional SQL as the generation check. Local timestamps are diagnostic only. Tests cover delayed reads with equal/skewed process clocks, expired/wrong owners, and lease loss before publication. Sam still consumes recurring evidence when boot JSON is malformed; a completed single batch never certifies absent evidence for unrelated boot sweeps. Existing race, cancellation and scheduler tests now supply explicit fixture leases without weakening assertions. The temporary verifier also checks the same SQL against an ephemeral PostgreSQL database.
