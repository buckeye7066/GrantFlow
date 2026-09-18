# Phase 2 follow-through: bounded stale-explanation completion

## Current production evidence

Base main: `1ea976423a9150ee97f493611e8b3a879b6903ea` (PR #1748).
Railway deployment `1abbd370-0047-4b15-9117-21364ca3f53d` completed its boot sweep at 2026-09-18T05:18:20Z. Its stale-explanation pass scanned/refreshed 800 records. The existing SQL LIMIT equaled the processing budget, so the loop could never observe an extra candidate and incorrectly returned truncated=false at a full batch boundary. The source-level limit defect is reproduced independently, not inferred solely from a log count.

The pipeline sweep separately reported scanned=140, kept=121, relabeled=19, removed=0, failed=0, unscorable=9, and protectedProfilesSkipped=1. These are not all school-origin failures. Direct database cohort verification remains unavailable while Home is offline; the nine unscorable rows are not explained or declared fixed by this change.

## Repair

The original stale-explanation writer remains the only write path. A batch now reads one overflow sentinel, measures stale records before and after through the same SQL predicate, and reports completion only from a valid zero-residue count. Query failures remain unknown. Existing score, proof, matcher-lane, and compare-and-swap rules are unchanged.

A small per-database coordinator gives production batches a 30-second follow-up when the measured residue decreased. It keeps the existing 800-pair/45-second batch budgets, uses one in-flight writer/timer per database object, rechecks the existing kill switch before follow-up, and stops on errors, no progress, zero remaining records, or 20 passes. Timers are unreferenced. Count-only calls never schedule writes, tests/dev do not auto-continue by default, and an explicit autoContinue=false requests one batch. A later explicit invocation can restart a bounded chain.

Each writing batch emits aggregate-only `refresh continuation` receipts with remaining_stale, complete, failure counts, continuation_status, and pass count. No credentials, profile names, applicant narratives, or medical data are added to those logs. This gives the live deployment a verifiable drain result without ad hoc production SQL or a manual restart per 800 records.

## Verification

The unmodified production module was reconstructed with matching git blob `0dae55768e5c92862fdf79922a8d9e54c2418417`. Five isolated behavior assertions failed before correction: overflow, residue count, completion, query failure, and count-only reporting. They pass after correction. Ten dependency-injected coordinator tests pass, including overlap, kill switch, no-progress stop, explicit resumption, and bounded scheduling. Real SQLite persistence and fake-clock integration tests are included for CI alongside all existing stale-refresh/proof/pipeline tests.

No acceptance threshold, match policy, application URL, profile answer, or submitted application is directly changed. The profile-signal derivation hash is unchanged because no derivation file changes. This is completion of existing refresh work, not a new discovery lane, AI call, or assertion that later discovery/Amy/web-parity phases are done.
