# 2026-09-17 — result quality: production capture, attribution, PR1

> Backend result-quality phase only. It does NOT close the owner's crawler
> request: discovery recall, before/after measurement, UI evidence, and release
> gates remain open (Gate B below). A saved plan is not a repair; this note
> records what was measured, what changed, and what is still unknown.

## Baseline (read-only capture, deployed commit a91267ac = origin/main)

Prod health `build.commit_sha = a91267ac…`; effective env `NODE_ENV=production`,
`SEMANTIC_RECALL=1`, discovery min-score env unset (floor 7). Capture via the
Railway public Postgres URL with `SET default_transaction_read_only = on`.

Profile under study: the live TN student (profile id held in the vault, sanitized into
`backend/tests/fixtures/regression/tn-student-2026-09-17/`). Facts that matter,
verbatim from `profile_sections`: `citizenship = "US citizen"`, `us_citizen = true`,
`nationality = American`, `disability_status = "No disability"`,
`medicaid_enrolled = true`, `medicaid_recipient_self = true`,
`medicaid_waiver_program = none`, `family_caregiver = true`, GPA 3.84, ACT 28,
MTSU, Cleveland / Bradley County TN 37312 (plus a stray `zip_code = 55402`).

Match store for this profile: 243 rows across 10 surfacing lanes
(crawler-os accept 5 / review 59; institution-link accept 38 / review 31;
catalog-rescore-link accept 16; student-aid-instate-link accept 16; …).

Fleet, active ACCEPT rows joined to their catalog row:

| slice | count |
|---|---|
| ACCEPT rows total | 916 |
| … on opportunities with **no eligibility text at all** | 375 (41%) |
| … with `state IS NULL` and not national | 213 (23%) — 194 in catalog-rescore-link |
| this profile: ACCEPT with no eligibility text | 77 of 96 (80%) |
| catalog rows sharing one `application_url` under >1 canonical key | 1,289 groups / 3,616 rows (mostly portal/search URLs — URL is NOT a safe identity) |

Boot integrity net (`enforce_invariants_last_run` 2026-09-16T20:38Z): 70 steps,
0 failed; `persisted_match_decision_integrity` scanned 1,922 repaired 0;
`stale_match_explain_refresh` scanned 0; `catalog_rescore_convergence` scanned
3,000 → rejectedByEngine 1,020, review 694, upserted 6.

## Attribution (first stage where the truth goes wrong)

Replayed locally through `computeMatchDecision` on the same commit
(`backend/tests/regressionResultQualityAttribution.test.js`). Decisions agree
with the captured rows; scores differ by lane and are not pinned.

| case | captured | replay | first wrong stage |
|---|---|---|---|
| **International Merit Scholarship** (`3c90e9fe`), row text "International students" | accept 79 (catalog-rescore-link), proof `profile_qualifies=true` via eligibility prose ("students") | ACCEPT 100, eligible=true, "eligibility … check out" | **engine**: no international-applicant exclusivity rule (only foreign *jurisdiction* is detected). Mirror of `requiresVeteran`/`requiresGender`. |
| **ECF CHOICES Family Caregiver Stipend** (`1143d9e4`) | accept 31 (crawler-os), `eligibility_bullets: []`, stub description | ACCEPT 28, eligible=true, `eligibility_factor 0.8` | **acquisition**: `ecfChoicesAdapter` branch-2 child rows carry no eligibility text (and `osOppToLiveRow` never writes `eligibility_text`); then **proof/explanation**: `profile_qualifies` passes on applicant-type evidence alone and the explanation claims eligibility checked out while the score already treats it as unknown. |
| **TennCare 1915(c) HCBS Waivers** (`3a0924a3`), requires I/DD; profile: none | accept 30 (crawler-os) | ACCEPT 18, eligible=true | same as above |
| ECF CHOICES parent (`c5f66900`), has description | review 10 | REVIEW, `condition_specific_condition_not_named` | engine correct where text exists — control case |
| **Jacksonville Board of REALTORS® (NC)** (`390af12b`), `state NULL` | accept 32 (catalog-rescore-link), reasons say "Location unknown", proof `relatable=true` | ACCEPT 63, `geo_factor 0.7`, "location check out" | **acquisition** (08-15 row has no geography; the 09-11 re-crawl of the same program (`3b0a363e`) has `state NC` but a different canonical key, so it never superseded) → **explanation/proof** overstatement. Sibling with state → REVIEW "based in NC … confirm" (engine correct when state is known). |
| profile ZIP | — | `signals.location.zip = 55402` | **profile normalization**: `profileHelpers.js` zip vote ties 1-1 (55402 vs 37312); first candidate wins. State still TN. |
| `POST /comprehensiveMatch` live-scoring branch | — | unreachable | **dead code** carrying a latent reject leak (no `match_decision` on its rows; relaxation to `slice(0, FALLBACK_TOP_N)` outside the ladder). Discover page was served by the persisted branch, which skipped G2 recovery. |

Corrections to earlier claims in this thread: TennCare is an *unknown* (she is a
Medicaid-enrolled caregiver; the care-recipient's ECF enrollment is unstated),
not the flagrant mismatch first assumed; the comprehensiveMatch leak was
real-but-unreachable, not live.

## PR1 — `fix/result-quality-attribution-pr1` (this branch)

CHANGED
- `backend/routes/discovery.js`: one selector `selectProfileOsResults` shared by
  `GET /discover-grants` and `POST /comprehensiveMatch` (surfaced lanes →
  canonical funnel → display gate → G2 Tier A/B recovery → four-truth boundary →
  dedupe → pipeline exclusion); dead live-scoring branch and its imports
  removed (−473 / +133 lines). Both responses carry `removal_ledger`.
- `backend/config/matchSurfacing.js`: `displayRefusal(row, minScore)` — why any
  row failed `qualifiesForDisplay` (reject / review / lifecycle / failed
  four-truth legs / pointer refusal).
- `backend/services/matching/removalLedger.js` (new): reason→count ledger with
  the reconciliation identity `loaded = returned + Σremovals − readmitted`.
- Fixtures: `backend/tests/fixtures/regression/tn-student-2026-09-17/`
  (profile + 12 sections, 8 catalog rows, 7 match rows, capture-meta with cases).
  Identity removed; eligibility facts verbatim.
- Tests: `comprehensiveMatchRouteAuthority` (reject-80 never returned and is
  accounted by decision; G2 recovery envelope on zero qualified; request
  validation; one-selector source pin), `removalLedger`, and
  `regressionResultQualityAttribution` (holding invariants as `it`; the five
  attributed defects as `it.fails` with the measured evidence — the repair that
  fixes a case must flip its block, so the suite cannot forget it).
- `matchConfidenceHonesty.test.js`: discovery.js now has one stored-confidence
  query (was two).

VERIFIED (local, this commit)
- `node scripts/run-vitest-isolated.mjs run` over the 3 new + 3 related suites:
  6 files, 64 passed, 5 expected-fail. ESLint `--max-warnings 0` on changed files: 0.
- Not yet verified: CI on the exact head, deploy, live envelope. See PR.

Behavior deltas on the live Discover path (persisted branch): recovery ladder
now runs when zero rows qualify (was: bare `zero_result`); four-truth boundary
and dedupe now applied (were not); admin inline-profile objects get 400
`profile_required` (were: unreachable live scoring). Response items are
`formatProfileSearchResult` shapes (superset of before).

## PR1 outcome

#1740 merged to `main` 2026-09-17T03:40Z (squash). CI on the merged head
`f7bf0253`: `test` 11m19s pass, `test-suite` 12m13s pass, migrations / image /
smoke / Windows / Android / CodeQL pass. First head failed only the
public-source privacy gate (fixture directory named with the given name; the
full production profile id embedded in match-row composite ids) — scrubbed in
the second commit; the real id now lives only in the vault.

## PR2 — engine / acquisition / profile normalization (this branch)

Every case below was re-measured by replaying the fixture through
`computeMatchDecision` after the change; decisions and wording are pinned in
`regressionResultQualityAttribution.test.js` (the five `it.fails` blocks are
now `it`), `internationalStudentRestriction.test.js`,
`eligibilityEvidenceExplanation.test.js`, `profileSectionLocation.test.js`,
and `crawler-os/tests/ecfWaiverLane.test.mjs`.

CHANGED
- `config/demographicRestrictionPatterns.js`: `internationalStudentRestriction`
  → `'exclusive' | 'audience' | null` (mixed "domestic and international" → null).
- `services/opportunityNormalizer.js`: `requiresInternationalStudent`
  (structured `requires_international_student` wins).
- `services/matchEngine.js`: `profileCitizenship(profileNorm)`;
  `evaluateEligibility` — exclusive + known US citizen → hard ineligibility,
  exclusive + unknown → missing `citizenship`, audience + known US citizen →
  missing `international_audience_mismatch` (score capped at `ACCEPT_SCORE-10`
  like the K-12 mismatch); `makeDecision` mirror with named REVIEW reasons;
  `eligibilityEvidenceLevel(opportunity, oppNorm)` →
  `prose | structured_flags | applicant_types_only | none`, carried as
  `eligibility_evidence` on every canonical result and in `match_explain`;
  the ACCEPT explanation says "eligibility and location check out" ONLY when
  eligibility prose AND a location were stated — otherwise it names what was
  not stated ("Applicant type matches; eligibility criteria are not stated by
  the source — confirm before applying." / "Service area not stated by the source.").
- `crawler-os/adapters/ecfChoicesAdapter.js`: program and child rows carry the
  program page's stated population (registry `resource_summary`, verbatim) as
  `eligibility_text` with `field_provenance.eligibility_text {source:
  parent_program_page|program_page, url, inherited}`. The existing
  `contract.js → OS store → pageFacts.buildLivePageFactColumns → osOppToLiveRow`
  pipe carries it to `funding_opportunities.eligibility_text` on the next
  crawl; nothing is invented (no summary → no text).
- `services/profileHelpers.js` `readSectionLocation`: a 1-1 ZIP tie is broken
  by the ZIP that resolves into the declared state (55402 vs 37312 → 37312;
  this also restored `county: Bradley`).

Measured after the change (same fixture, same commit family):

| case | before | after |
|---|---|---|
| International Merit ×3 (US citizen) | ACCEPT 100 / eligible=true | REVIEW / eligible=maybe / `international_audience_mismatch` / score capped |
| ECF Caregiver Stipend (no text) | ACCEPT "eligibility and location check out" | ACCEPT, `eligibility_evidence=structured_flags`, "detailed eligibility criteria are not published… confirm before applying" |
| HCBS Waivers (no text) | ACCEPT "…check out" | ACCEPT, `applicant_types_only`, "eligibility criteria are not stated by the source" |
| Jacksonville no-geo | ACCEPT "…location check out" | ACCEPT, `prose`, "Eligibility checks out. Service area not stated by the source." |
| ECF parent | REVIEW | REVIEW (unchanged) |
| ZIP | 55402 (MN) | 37312, county Bradley |

Decisions I made and why (owner may overrule):
- `eligible` stays decision-derived (`ACCEPT → true`). Flipping it to `'maybe'`
  for every row without eligibility text would demote 41% of the fleet's
  accepts and delete their proofs via the boot integrity net — the verdict
  rule "silence is neutral" (G4) is ratified. The honest fix is the CLAIM:
  `eligibility_evidence` + wording now; PR3 threads it into the four-truth
  `profile_qualifies.evidence_basis` and the card ("Confirm eligibility").
- Recorded tension, not changed: `needFirstMatchPolicyV2.positiveFactMismatches`
  (owner 2026-09-05, pinned by `needFirstMatchPolicy.test.js`) hard-REJECTS
  "international students only / exclusively for international students /
  non-US citizens only / foreign students only" when the profile has NO
  international signal — i.e. unknown → REJECT, stricter than G4. The new gate
  agrees with it for a known US citizen and holds REVIEW (missing
  `citizenship`) for unknown citizenship on the phrasings it adds. Two rules,
  one seam; owner call whether the ratified rule should soften to REVIEW.
- Existing catalog rows are NOT rewritten by this PR. The ECF child rows gain
  eligibility text on their next `tn_ecf_choices` crawl; persisted ACCEPT
  match rows for the affected pairs re-score on the next canonical rescore /
  crawler-os run. A targeted refresh is the post-merge step, verified by the
  live envelope for the captured profile.

## PR2 outcome

#1741 merged to `main` 2026-09-17T04:14Z (squash). First head failed only the
profile-signal hash tripwire (by design — three derivation files changed);
bumped `PROFILE_SIGNAL_VERSION` to `2026.09.17-1` and re-pinned. The bump is the
targeted refresh: every stored explain from the old derivation is stale and the
boot drain re-scores it (800 pairs / 45 s per boot).

## PR3 — evidence contract on the proof and the card (this branch)

CHANGED
- `crawler-os/fundingTruthPolicy.js`: `proofEvidenceBasis(canonical,
  opportunity, previous)` → `{ eligibility: prose|structured_flags|
  applicant_types_only|none|unknown, geography: national|stated|unknown }`.
  Eligibility is the engine's `eligibility_evidence`; for decisions that
  predate it, derived from the row's own eligibility text / stated applicant
  types, else the previous proof's basis, else `unknown`. Geography reads an
  OS opportunity (`geography.{national,states}`) or a catalog row
  (`is_national`, `state`, `geo_eligibility`). Both proof builders
  (`buildFourTruthProof`, `refreshFourTruthProof`) emit it as a top-level
  `evidence_basis` block; the legs' `passed` values are unchanged (the existing
  strict-equality tests on `relatable` still hold).
- `src/lib/matchDisplayThresholds.js` `canonicalMatchDisplay({ score, decision,
  eligibilityEvidence, geoEvidence })` → adds `confirm_eligibility`
  (`true|false`, or `null` when the caller passed no evidence — legacy call
  sites unchanged), `evidence_note`, `eligibility_evidence`, `geo_evidence`.
  An ACCEPT below `prose`, or with an unstated service area, needs
  confirmation; REVIEW/REJECT never carry the chip (the label already says it).
- `src/components/funding/toCanonicalResult.js`: derives `eligibility_evidence`
  / `geo_evidence` for every row with a fallback ladder (engine level → proof
  `evidence_basis` → proof evidence arrays → row text/geography → `unknown`),
  so rows scored before PR2 render conservatively rather than as verified.
- `FundingResultCard`: header label is now decision-first
  (`canonicalMatchDisplay`, so a REVIEW never reads "Excellent Match"); a
  "Confirm eligibility first" chip with the evidence note; the CTA reads
  "Confirm eligibility, then apply" (amber) instead of "Open application" when
  confirmation is needed. Raw rows without evidence fields render as before.
- `PROFILE_SIGNAL_VERSION` → `2026.09.17-2` (the policy file is hash-pinned);
  refreshed proofs gain `evidence_basis` on the boot drain.

For the captured profile: Jacksonville (state NULL) → `prose` / `unknown` →
"Confirm eligibility first … service area is not stated"; ECF Caregiver
Stipend → `applicant_types_only` → "Only who may apply is stated … confirm
before applying"; International Merit rows are REVIEW after PR2 and carry no
chip — the label already says "Needs review".

## PR3 outcome

#1742 merged to `main` 2026-09-17T04:35Z (squash → `e4a39d0b`). Green first
head (pinned the signal version before pushing this time).

## PR4 — recall scorecard + skipped-query carry-over (this branch)

**Gate B baseline, read-only prod probes 2026-09-17 (deployed 9580bd67),
`system_kv web_lane_last_runs` + `crawler_source_runs`:**

| profile (real, active) | queries planned → executed (skipped for budget) | candidates extracted | gate rejections | admitted | binding constraint |
| --- | --- | --- | --- | --- | --- |
| captured TN student | 28 → 7 (21) | 24 | apply_target 9 · eligibility 5 · reality 3 · review-held 6 | **0** | `gated_at_apply_target` |
| senior / caregiver | 28 → 7 (21) | **0** (`extraction_failed:llm_quota`) | — | 0 | `extraction_dead` |
| individual | 28 → 7 (21) | ~11 | eligibility 9 | 0 | `gated_at_eligibility` |

The recall funnel dies at a DIFFERENT stage per profile, and the same 21
queries are skipped every night because the plan is rebuilt identically — the
7 that run are the 7 that already failed to fill the target. Nothing on the
product laid these stages end to end; every prior "recall" claim was a single
count argued in isolation. `qualified_admitted` was 0 across the cohort with a
"healthy" web lane and nothing red anywhere.

CHANGED
- `services/coverageAudit/recallScorecard.js` (new): `stageCountsFromLane`
  (the lane record's stage ledger, normalized, with `budget_skipped_share`);
  `classifyRecallBlocker({lane, audit})` — ONE stage in funnel order
  (`unconfigured` / `met_target` from the audit first, then `no_run` →
  `search_unavailable` → `extraction_dead` → `budget_starved` → the largest
  gate → `held_for_review` → `admitted_below_target`); `carryOverSkippedQueries`
  (cap `CARRY_OVER_LIMIT`=4 so a 7-slot budget still executes 3 core queries;
  empty after a dead-extraction run); `buildProfileRecallScorecard` (lane store
  + match store by surfaced lane + proven direct accepts + coverage audit +
  `grants` by status + `vnext_applications` by state; an absent table reads
  `null`, never 0; `verified_external_submissions` is `null` by design — the
  Hamilton proof predicate is per task); `buildFleetRecallScorecard` (real
  active non-Amy profiles, shares, blocker histogram, metric envelope whose
  `context.definition_of_better` is fixed in code); `recordRecallScorecard` /
  `getLastRecallScorecard` / `getRecallScorecardHistory` (`system_kv
  recall_scorecard_last_run` + `recall_scorecard_history`, cap 14).
- `profileResultCoverageAudit.js` heal loop: `runProfileDiscoveryLive({…,
  extraQueries: carried})` with the previous lane record's budget-skipped
  queries; `healed[].carried_queries` records how many. The sweep result and
  the persisted `coverage_audit_last_run` gain a `recall_scorecard` block, and
  the fleet snapshot is recorded at the end of every nightly sweep (reuses the
  sweep's audits).
- `routes/admin.js`: `GET /api/admin/recall-scorecard` (persisted by default;
  `?live=1`, `?persist=1`, `?limit`) and `GET /api/admin/recall-scorecard/:profileId`.
- `samRegistry.js`: `recall.scorecard` — stale >48h, or ≥80% of profiles with
  extraction alive (min 3) admitting ZERO qualified candidates → fail, naming
  the top blockers. On today's prod numbers this check is RED, which is the
  honest state.

**Definition of "better" (fixed so it cannot be gamed):** primary =
`surfaced.awardable` and `surfaced.applyable_typed` per profile; secondary =
`stages.qualified_admitted` per run; `candidates_extracted` / `queries_executed`
are diagnostic only. Two snapshots compare only with provider health
`healthy` on both and the same `code_version` family.

**What the lever does and does not claim.** It widens what is SEARCHED on
heal runs only; every hit still faces fetch → extract → reality gate → engine.
It cannot help a profile whose blocker is `extraction_dead` (nothing is
carried then) or `gated_at_*` (those are precision gates on candidates already
found). Whether it moves `qualified_admitted` / `awardable` is UNKNOWN until
the persisted snapshots show it — no improvement is claimed here.

VERIFIED (this branch, local): `recallScorecard.test.js` (25),
`coverageSweepCarryOver.test.js` (4 — through the REAL sweep with a mocked
`runProfileDiscoveryLive`: the call carries the first 4 skipped queries,
carries none after a dead-extraction run, unchanged with no prior record; the
sweep persists the snapshot), `adminRecallScorecard.test.js` (4); neighbours
`profileResultFloorBackfill`, `coverageSweepObservability`,
`coverageGapScoreboard`, `samDiscoveryAwareness` green; lint, typecheck,
profile-scope, safe-sql, secret scan, profile-metadata, privacy green;
signal-version pin unchanged (no derivation file touched).

## Still open (Gate B — measured, not closed)

- **Before/after**: the first persisted snapshot lands on the first nightly
  sweep after deploy; compare `recall_scorecard_history` entries (same
  `code_version` family, provider health healthy) on `awardable` /
  `applyable_typed` / `qualified_admitted`. Until then nothing about recall is
  "better" — it is measured.
- The dominant prod blockers are BELOW the top of the funnel:
  `gated_at_apply_target` (apply-URL rescue / source adapters) and
  `gated_at_eligibility` (eligibility evidence on source rows) — separate
  levers, each to be judged on the same card.
- `runApplyableFloorBackfill` (the per-type archetype lane) does not yet carry
  skipped queries; only the awardable heal loop does.
- `SEMANTIC_RECALL` cohort, `extraSeedPages` replay of gap seeds — not touched.
- Live envelope check for the captured profile after the boot drain re-scores
  its rows (the persisted International Merit accepts flip to REVIEW only when
  re-scored; the drain is bounded per boot).
- Owner decisions recorded above: `eligible` stays decision-derived; the
  ratified 2026-09-05 "…only" rule stays stricter than G4.
- Separate: `admin.js` HTTP dry-run modes (`:5576`, `:5704-5741`) violate the
  owner no-dry-runs rule for owner-facing routes; internal
  `runProfileDiscoveryLive({dryRun})` is a read-only test seam and stays.

## Traps learned

- .NET file APIs in PowerShell use the *process* cwd, not `$PWD`, and write CRLF.
- `it.fails` is the honest way to commit a measured-but-unrepaired defect: green
  now, and it turns red the moment the repair lands without updating the test.
- A synthetic URL in a reject fixture gets dropped for *trust* before the
  decision is read — clone a real verified row or the test proves nothing.
