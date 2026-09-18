# Phase 2 continuation: source-grounded school-origin eligibility

## Recovered delivery checkpoint

- Previous PR #1747 was already merged as `09e8e5b8306a672dc1678b8f79788a5304cf5f72`. Both Railway health and Vercel production deployment `dpl_2LnZt1Q1RkejVCwjSbzdBTFZgygW` were independently checked at that exact revision.
- Read-only verification after the previous canonical stale refresh: the frozen nine-match cohort has zero invalid accepted or displayable targets and all nine catalog sources remain. One match was already absent in the immediate pre-deployment snapshot; do not attribute that disappearance to this release.
- Of the frozen 31 pipeline rows, 19 belong to the canonical protected promotional profile. Their substantive snapshot fields are preserved. Four `updated_at` values differ; do not claim byte-for-byte preservation of every column. The other 11 progressed rows were preserved and flagged, and one early invalid row was removed. All source records remain.
- The old pipeline verifier failed because it omitted the protected-profile exemption. Do not modify the protected profile to satisfy that mistaken assertion. Resolve protection with `deriveProfileFacts`, not another name/ID registry.
- The existing golden-outcome diagnostic still passes its 12 assertions for two profiles. This is a preservation check, not a newly created outcome.

## Source and bounded repair

Official source: https://bafwv.org/mary-louise-klaus-memorial-scholarship-fund/ . Its requirement concerns graduation from a public high school in Raleigh County, not present residence. The live catalog read at 2026-09-18T01:52Z expresses the county and state before “high school graduates”; it does not retain the public-school restriction. The parser must not invent that missing restriction from a sponsor address or outside knowledge.

- `schoolOriginEligibility.js` is the shared authority for the supported school-county graduation statements. Both normalized eligibility and canonical decisions consume it.
- Source-specific requirements are compared only with explicitly declared high-school county, state, type and graduation year. Present home and college fields are not substitutes. Missing evidence stays REVIEW; a completed graduation history with an explicit contradiction may be rejected.
- Negations, preferences, historical recipient/donor descriptions and widened alternatives must not become exclusive applicant requirements.
- The three new profile fields are unscored in backend schema and editable frontend metadata. Fingerprints include relevant school facts and source restrictions. Signal version advances to `2026.09.17-4` so old evidence is re-evaluated by existing maintenance.
- No score threshold, source/application URL, catalog record, profile value or historical application is changed by this patch directly.

## Verification checkpoint

Initial red: 10 behavior assertions failed against the previous implementation. A second red reproduced four boundary gaps: stored source wording, metadata, historical-recipient text and evidence classification. After correction, 68 focused cases passed across four suites; one additional funder-state/history control was then added. Two real SQLite refresh cases prove old positive eligibility evidence stops authorizing display in crawler and linker lanes while the linker retains admission provenance.

Full prepush, unit/crawler suites, current-head review, merge and exact-revision production readback remain required at this checkpoint. This document does not close recall, missing-target rescue, Amy cohort accounting or web-parity phases.
