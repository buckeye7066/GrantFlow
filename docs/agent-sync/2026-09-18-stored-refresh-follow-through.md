# Phase 2 follow-through: bounded stored-match refresh

## Evidence and scope

PR #1748 merged as `1ea976423a9150ee97f493611e8b3a879b6903ea` and deployed to Railway and Vercel. Its Railway boot receipt at 2026-09-18T05:18:20Z reported 800 stale explanations refreshed; pipeline precision scanned 140 rows, relabeled 19 and deleted none. This is execution evidence, not proof that all stored matches were current. Direct database readback remains unavailable while Home is offline.

Reading the deployed implementation established three connected defects:

1. The query returned at most the batch budget. The loop only set `truncated` when another row was encountered, so a full batch could falsely report that nothing remained.
2. The boot wrapper discarded the service's `ok: false`, skipped-query status and persistence/conflict diagnostics. The general invariant runner then defaulted that result to green.
3. The bounded explanation drain ran only during boot. The existing recurring link-verification callback did not resume it.

This repair does not change eligibility, matching scores, source/application target policy, applicant facts, protected statuses or application submission behavior.

## Repair ownership

- `staleMatchExplainRefresh.js` reads one additional sentinel but still processes/writes at most the existing batch budget. A remaining row makes truncation observable; exact-size and empty populations remain non-truncated.
- Optional scheduler cancellation is checked before work, between rows, after profile loading and before starting a match write. Existing compare-and-swap and four-truth provenance logic remains unchanged.
- `enforceStaleMatchExplainRefresh` forwards the cancellation signal, propagates the service result and retains failure/deferred diagnostics in the canonical persisted-step projection. Missing dependencies are not reported as successful enforcement.
- The existing recurring link-verification callback resumes one bounded refresh after boot and link repair, using the existing scheduler lease, before task-truth maintenance. No second timer, unbounded drain or larger write budget was added. Refresh failure is logged explicitly without silently suppressing unrelated task-truth work.

## Verification before PR

New regression cases ran against unchanged production source: 14 tests, 9 genuine assertion failures and 5 passes. After the exact-anchor repair, the new tests and the existing stale-refresh, boot-invariant, four-truth and signal-version suites passed, followed by the complete `npm run check:prepush` chain and whitespace/syntax checks. GitHub Actions run `35312321771` published validated source commit `a9167ed572655664a0138aa25b3567bba2246fc2` only after those steps succeeded.

One existing boot test uses a deliberately incomplete database with no match store. Its previous zero-failure expectation hid the query defect. It now expects exactly one failed step, names `stale_match_explain_refresh` and `skipped: query`, and retains the complete 70-step inventory.

The scheduler regression executes the actual function from `server.js` with local injected dependencies and clocks: it verifies waiting for boot, lease-signal forwarding, ordering before task truth, explicit failure reporting and no refresh after cancellation. SQLite regressions verify sentinel non-write, count-only behavior and two-batch convergence. No test contacts production or changes real applicant records.

The temporary branch-only execution workflow and exact-anchor patch script were removed after publication. They are not part of the production change. This revision still requires full current-head PR checks, review, merge and exact-revision production verification before delivery is claimed. Consult the PR delivery receipt for final deployment status.

## Remaining work

A clean deployment or `truncated: false` alone does not establish that every historical record is current. Inspect deferred/error counters and the recurring production receipt. Do not advance Phase 3 recall, Phase 4 Amy cohort, or Phase 5 web parity based on this maintenance repair; those require their own same-population funding-outcome evidence. Home's checkout and own edit-lock remain unsynchronized while disconnected.
