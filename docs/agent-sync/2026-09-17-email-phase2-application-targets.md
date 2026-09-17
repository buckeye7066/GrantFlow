# Email Phase 2: non-application targets

Goal: keep known grant-writing/vendor logins and editorial pages from being treated as direct funder application targets, without deleting useful discovery leads.

Evidence: the reported scholarship's created catalog snapshot (2026-09-17T01:46:41Z) had empty structured states, an explicit school-graduation condition in its prose, and an alpha.grantable.co login as its application URL. A current-code reconstruction with the existing sanitized student fixture returns ACCEPT 21 when state is absent and REVIEW 6 with WV. This reproduces a vulnerability, not the complete historic admission event (grant/promotion rows are gone).

External verification: https://grantable.co/ identifies itself as grant-writing/discovery software; https://bafwv.org/mary-louise-klaus-memorial-scholarship-fund/ states a graduation-from-school requirement. Present residence must not be substituted for school history.

Implementation:
1. Add failing behavioral tests for the canonical URL guard, the real match engine, extraction retention, and actual pipeline persistence.
2. Extend the existing applicationSurfaceHosts authority for the verified vendor host; reuse it in the canonical post-decision application-target guard. Known non-application targets hold ACCEPT at REVIEW, preserving scores and sources.
3. Remove such targets from extracted candidates after hub decomposition, retaining info URL and structured refusal provenance. Make crawl-stage accounting report the apply-target hold.
4. Keep valid funder URLs and tenant submission portals unaffected. Do not guess replacement URLs or change residency/scoring thresholds.
5. Pin the signal version, run targeted/integration/regression and prepush checks, review, merge only after CI, verify exact deployed commit, and read back affected production matches.

Remaining separate work: source-grounded school-origin eligibility, historical admission evidence gaps, legitimate missing-application-target rescue, and later phases. No broad phase completion is claimed by this repair.

## Changed and locally verified
- The canonical application-surface registry now identifies Grantable software pages. The engine consults the existing registry on application_url / apply_url / url, retains the source and score, and holds invalid application targets at REVIEW.
- Extraction checks after hub decomposition, retaining every candidate and its fetched source plus a structured refusal instead of a false apply link.
- The crawler facade carries that refusal into the stage ledger as apply_target_rejected; it is not mislabeled as failed eligibility or a search outage.
- PROFILE_SIGNAL_VERSION=2026.09.17-3; the surface registry is added to the derivation hash so future edits invalidate old ACCEPT proofs. Existing boot rescore is the cleanup consumer; no ad-hoc data edits.
- Red: 10/18 new behavior tests failed, including the REAL SQLite-backed saver persisting the vendor target. A separate ledger regression failed 1/12. Green: 164 tests across 12 suites, including real pipeline write/readback, existing precision/promotion and result-quality controls.
- Full check:prepush passed, exit 0: static/security gates, lint, crawler lint, typecheck, production build.
- Live read-only baseline at 2026-09-17T18:34:21.731Z: 847 active stored ACCEPT pairs; 9 carry known non-application targets across 7 profiles (7 Grantable, 2 editorial). Before/after must compare these same pairs, not claim every fleet change was caused by this patch.
- Merge, exact deployment, and persisted after-state are not verified yet.

## Prior phase delivery
The Factory Deck QA repair in #1746 was subsequently installed and run. The signed production result evarun_f39d3032274d916b947ffa36 recorded four passing journeys and resolved the six-occurrence finding at 2026-09-17T18:08:58.103Z. This does not prove app generation.
