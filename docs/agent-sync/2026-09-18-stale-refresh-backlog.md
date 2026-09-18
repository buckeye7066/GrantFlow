# Stale-match refresh: a batch is not the whole backlog

## Verified production checkpoint

Main/deployment revision: `1ea976423a9150ee97f493611e8b3a879b6903ea` (PR #1748).
Railway deployment: `1abbd370-0047-4b15-9117-21364ca3f53d`.

The 2026-09-18T05:18:20Z boot summary reports stale-match refresh scanned 800 and repaired 800, exactly its default page limit. Separately, pipeline precision scanned 140, kept 121, relabeled 19, removed zero, and reported zero write failures. Its nine unscorable rows are NOT explained by the 19 policy-gate reasons. Without a direct database read, the causes of those nine rows, the remaining stale count, and the latest golden-outcome result remain unknown. Home is offline; do not equate a successful deployment with these missing checks.

## Reproduced defect and bounded correction

The refresh SELECT limited its result to the work budget. The loop could only mark truncation when it encountered another row, so a full page with additional candidates outside the SELECT incorrectly returned `truncated: false`.

- Read one lookahead candidate; score and write no more than the existing work budget. The 800-pair default and 45-second processing budget are unchanged.
- After the attempt, count the same active-catalog candidate scope. Return `remaining_candidates`, `verified_at`, `verification_failed`, `complete`, and `status` in addition to existing fields.
- `remaining_candidates` is the existing SQL predicate's conservative candidate count, not a claim that every candidate fails the JavaScript freshness check. Only a verified zero, enabled writes, successful processing, and no unresolved profile/scoring skips can mark this drain complete.
- Failed readback leaves the count null, not zero. Count-only, failed, and pending outcomes remain distinct. An aggregate-only log receipt makes these facts available without database credentials or applicant data.
- Preserve all canonical decisions, proof refresh/history, compare-and-swap checks, source records, lane identity, and application history. No new scheduler, unbounded retry loop, scoring changes, or admission relaxation.

This patch establishes truthful completion evidence. It does not itself schedule another batch, repair missing-catalog pipeline records, or certify the golden outcomes. The existing invariant wrapper reports its legacy fields; the new per-batch receipt is the authoritative detailed result for this scope, not the generic boot `ok` field.

## Verification

Local reproduction used byte-verified production refresh and persistence modules with real SQLite, injected deterministic engine/profile inputs, and isolated imports for unrelated logger/proof dependencies. Original refresh blob: `0dae55768e5c92862fdf79922a8d9e54c2418417`; unchanged persistence blob: `57af34847eda8f1c19961ec2acf290ee28b5a772`.

Initial red: 15 assertions failed, including the actual full-page truncation defect. An additional malformed-count control exposed empty string/false being coerced to zero; both were corrected. Final isolated tests: 22 passed, zero failed/skipped, including exact-budget completion, bounded continuation, count-only preservation, time exhaustion, missing profiles/policy, scoring and write errors, concurrent updates, inactive source scope, conservative SQL false positives, string counts and aggregate-only receipts.

The tests are registered under the existing `tests/unit` Node runner. The local harness is not a full project installation and is not shipped. Exact-head project CI and production log readback remain release gates. No new funding outcome, broader discovery-coverage improvement, or completion of later Amy/web-parity phases is claimed.
