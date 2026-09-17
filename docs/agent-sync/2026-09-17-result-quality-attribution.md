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

## Next PRs (each gated on its failing fixture)

- **PR2 engine/acquisition**: `requiresInternationalStudent` flag in
  `opportunityNormalizer` + rule in `evaluateEligibility`/`makeDecision`
  (known US citizen → reject; unknown citizenship → missing field); explanation
  text conditional on evidence (never "check out" when eligibility or location
  is unknown); ECF adapter child rows carry the parent page's eligibility
  statement, `contract.js` → `osOppToLiveRow` write `eligibility_text`/`_bullets`
  when stated; ZIP tie-break by state consistency. Flip the matching `it.fails`.
- **PR3 evidence contract**: additive `profile_qualifies.evidence_basis`
  (`stated_requirements | applicant_type_only | none`) and
  `relatable.geo_evidence` on the four-truth proof; `canonicalMatchDisplay` /
  FundingResultCard render "Confirm eligibility" and never "Apply now" for
  applicant-type-only or unknown-location accepts; old rows without the field
  render conservatively. Refresh affected persisted rows.
- **PR4 recall (Gate B)**: gap-seed replay through
  `runProfileDiscoveryLive({ extraQueries, extraSeedPages })`, semantic recall
  cohort, before/after scorecard per the stages in the plan.
- Separate: `admin.js` HTTP dry-run modes (`:5576`, `:5704-5741`) violate the
  owner no-dry-runs rule for owner-facing routes; internal
  `runProfileDiscoveryLive({dryRun})` is a read-only test seam and stays.

## Traps learned

- .NET file APIs in PowerShell use the *process* cwd, not `$PWD`, and write CRLF.
- `it.fails` is the honest way to commit a measured-but-unrepaired defect: green
  now, and it turns red the moment the repair lands without updating the test.
- A synthetic URL in a reject fixture gets dropped for *trust* before the
  decision is read — clone a real verified row or the test proves nothing.
