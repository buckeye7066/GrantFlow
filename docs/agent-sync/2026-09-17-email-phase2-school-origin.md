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

## Current-head review corrections

The first full unit run exposed 42 failures in ten existing suites: the new makeDecision guard dereferenced an optional null normalized profile. Five additional direct-call tests reproduced both that contract break and a soft school-history hold masking a later exclusive-residency rejection. The guard now consumes the canonical school normalizer when sections are supplied directly, and its REVIEW return follows the hard applicant/geography gates. All 356 tests across the new suite and the ten affected suites then passed.

Codex and CodeRabbit review findings were independently reproduced. The correction reads legacy education_information/student sections with existing precedence, binds graduation wording to the applicant rather than an organization's beneficiaries, retains current restrictions following historical fund-establishment prose, and preserves alternatives after comma-delimited states. Six additional red cases now pass. A UTC school-evidence period and derived graduation-completion fingerprint invalidate unchanged stored decisions when the graduation period rolls over; both JS and real SQLite stale selection are tested before and after the boundary.

The claim that pipeline reconciliation was absent was not correct for this base. Existing enforcePipelinePrecision re-scores every non-exempt catalog-backed row through scoreRowWithEngine and re-stamps it; gateEngine already handles hard refusals. Three real SQLite cases verify that a known school mismatch removes an early row, flags but preserves a saved row, and changes a missing-school saved row from ACCEPT to REVIEW. No second cleanup implementation was added.

The reviewed-corrections regression set passed 107 tests across school history, calendar freshness, persisted explain, real stale refresh and real pipeline reconciliation. Final current-head full gates and exact-revision production delivery remain required; initial-head green checks are not evidence for the corrected head.

## Resumed after interruption: applicant-clause review

Recovered exact head c2264c684970aede67a76f87e9f680668d88c2b6. Its complete unit command, all 532 crawler cases, full prepush and all reporting CI jobs had passed. The remaining current-head review findings were real: mandatory scope separated from graduation by applicant-relative/conjoined clauses, a founder-preface hiding an explicit applicant mandate, and county-first historical reporting mistaken for current eligibility.

Twelve added controls reproduced eight failures, then all 127 cases in the five focused suites passed. The shared parser now carries mandatory scope only across applicant-relative/conjoined clauses, refuses organizational-beneficiary and alternative/negated scope, and lets an explicit applicant mandate outrank an incidental historical preface. County-first unsupported prose no longer becomes a requirement just because the sentence starts there; an eligibility-field declaration remains supported and a historical reporting suffix is refused.

The signal version remains the unreleased 2026.09.17-4 with its derivation hash freshly pinned. No profile answers, live records, application targets, scoring thresholds or protected history were changed directly. Final corrected-head checks, review, merge and production verification are still required. Stay in Phase 2; do not restart or advance to Phase 3.

## Applicant-owned intake boundary

Review of 59f5f3ec identified two source-wording gaps and a real intake/identity mismatch. The source parser now honors current scholarship-is-for clauses and excludes historical award-report suffixes in forward as well as county-first statements. Thirteen new backend assertions and one actual editor test failed before the correction.

Adults and parent/household applicants can now enter their own four unscored school-history facts in Basic Information. Education remains student-scoped; this does not expose all student questions to adults, classify a retiree as a student, or infer a current education need. The shared school normalizer accepts profile type, refuses child education as parent evidence, and names the editable applicant fields when facts are missing. Explicit parent facts never borrow a missing school type or graduation year from children. Student fixtures now explicitly use the student profile type; separate real adult and family controls exercise the new intake contract. Existing adult legacy history is retained when new fields only contain defaults.

Fresh verification: 180 cases passed across ten suites, including actual adult editor save/readback, organization field exclusion, family positive and negative controls, schema/metadata agreement, calendar invalidation, persisted explanations, and real pipeline/stale-match refresh. Full exact-head release checks and production delivery remain outstanding at this checkpoint. No production data was changed by this correction.
