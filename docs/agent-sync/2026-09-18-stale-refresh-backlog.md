# Stale-match refresh: verified backlog and durable diagnostics

## Production finding

Main at investigation: `1ea976423a9150ee97f493611e8b3a879b6903ea` (PR #1748), Railway deployment `1abbd370-0047-4b15-9117-21364ca3f53d`.
The 2026-09-18T05:18:20Z boot summary reported exactly 800 matches scanned and repaired, its default page limit. The SQL query could not expose a next row, so the loop could not report that more work remained. A completed batch did not establish an empty backlog.

Separately, pipeline precision scanned 140, kept 121, relabeled 19, removed zero, and reported zero write failures. Its nine unscorable rows are not explained by those 19 policy-reason counts. Home is offline; direct database attribution for those nine rows and a fresh golden-outcome readback remain unavailable.

## Correction

- Read one lookahead candidate but score and write no more than the existing pair budget. Keep the 800-pair default, 45-second processing budget, canonical decisions, proof history, compare-and-swap conditions and lane identity.
- Count remaining candidates after the attempt with the same active-catalog scope and a freshly constructed calendar-sensitive predicate. Invalid or failed counts remain null, never zero.
- A SQL zero is not enough: marker-based SQL can miss malformed JSON. Before reporting completion, inspect the active-scope explanations through the canonical JavaScript freshness predicate, with a read-only 10,000-row maximum and the remaining processing time budget. A partial, timed-out, failed or calendar-crossing audit remains incomplete.
- Distinguish `remaining_candidates` from exact `remaining_stale`. Preserve explicit null, false and zero, verification counters/timestamps, and complete/pending/disabled/failed status.
- Carry those facts and service failures through the existing invariant wrapper and its persisted projection, so Sam and Anya do not see a successful boot step after verification failed. Other invariant projections are unchanged.
- Emit an aggregate-only receipt without applicant identifiers, URLs, source titles or profile evidence. No new scheduler, direct profile edits, source deletion, application-history mutation, acceptance relaxation or unbounded retries.

## Verification and fixtures

The new controls first failed on the prior source, then passed after correction. The Node suite covers 27 cases: page-boundary lookahead, exact-size completion, bounded continuation, disabled writes, time exhaustion, missing profiles/policy, engine/write/query failures, concurrent corrections, inactive-source scope, conservative SQL matches, typed count handling, calendar rollover, malformed JSON, partial exact audits and aggregate receipts.

Nine new Vitest cases use the real invariant wrapper and persisted projection, including real SQLite JSON round-trip, failure propagation and unrelated-step preservation. Existing stale-refresh, four-truth-proof and full invariant-runner suites also passed in Actions run `35318852037`, followed by lint, typecheck and the unchanged signal pin check. That run published source commit `ede823f022b792716fcfb4ffd5ecabdd6c643d61`.

The healthy runner fixture now includes empty match, catalog and profile-section tables; the unchanged 70-step inventory and zero-failure assertion are retained, with an explicit failed-step assertion added. A test hook was corrected to avoid returning a mock as a teardown callback.

A temporary exact-base Actions job reproduced the failures and applied only the hashed source/test edits. Its workflow and patch script are removed from the final PR tree. Full exact-head CI and production readback remain the release gates, not this checkpoint's targeted-test evidence.

## Remaining follow-through

This patch reports the backlog honestly; it does not itself schedule another batch. PR #1749 separately contains bounded recurring refresh and cancellation work and must be reconciled with these diagnostics before merging. Its recurring result also needs a durable consumer-visible record, not only a console message. The two overlapping branches must not be merged blindly.

No new funding outcome or completed application is claimed, and the later discovery-recall, Amy cohort and web-parity phases remain open. A deployment success does not establish that historical matches have all finished refreshing.
