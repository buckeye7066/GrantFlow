# Recall-guardrail audit — 2026-08-03 (the "banish-list")

Owner directive: *"Whatever guardrails were implemented that contradict the rule
that GrantFlow is to find real relatable sources that uses all of the
information from the profile … banish those guardrails."* Governing
distinction: **HONESTY gates stay** (never fabricate URLs/amounts/submissions,
never bypass 2FA/CAPTCHA/terms); **recall-suppressing guardrails must justify
themselves with measured evidence or be removed/loosened**. Precision is
achieved by classifying junk out, never by starving recall.

Every number below was measured read-only on prod (railway ssh, pg over
`DATABASE_URL`) at the timestamp given. The store moves hour to hour — quote
the timestamp or the number is a story.

## The scoreboard (2026-08-03T16:49Z unless noted)

| # | Guardrail | Where | Measured suppression | Verdict | Action taken |
|---|---|---|---|---|---|
| 1 | **Rolling-snapshot match store, no general re-score** | `crawlerOsPersistenceCore.persistRun` (by design) + *absence* of a catalog-wide sweep (CLAUDE.md: "STILL OPEN WORK") | **641 of 11,050 active non-pointer catalog rows (5.8%) have EVER carried a match row for ANY profile.** Per golden profile: Anastasia 10,930 / Robert 10,933 / Gilbert 11,030 active non-pointer rows never scored for them. | **REMOVE the hole** (the snapshot itself is KEEP by design — the fix is the missing sweep) | `services/matching/catalogRescoreSweep.js` + boot step 53 `catalog_rescore_convergence`. ACCEPT-only, cursor-paced, `matcher_version 'catalog-rescore-link'`. **Writes env-gated OFF** — see "the flood" below. |
| 2 | **webQueries cap `maxQueries` 14** | `crawler-os/webLane.js` (default), pool built by `crawler-os/webQueries.js` | **All 34 of 34 real profiles truncated.** 2,531 profile-keyed queries built fleet-wide vs 476 run — **81% of the queries the profile's own facts justify never execute**; per-profile truncation p50 61, max 129. With one rotating tail slot, a p50 profile needs ~61 nights to see each broadening query once. | **LOOSEN** | Defaults 14→20 queries, 26→32 pages; all three budgets env-tunable (`WEB_LANE_MAX_QUERIES`, `WEB_LANE_RESULTS_PER_QUERY`, `WEB_LANE_MAX_PAGES`). Every extra query still faces SERP→fetch→LLM-extract→reality gate→engine. |
| 3 | **`GAP_SEED_LIMIT_PER_RUN` 8** | `services/webParityBenchmark.js:101` | **Zero pending suppression today**: queue holds 200 candidates — 150 `gated_out`, 50 `adopted`, **0 `candidate` (pending)**. The queue is drained; the limit is not currently costing a single seed. | **KEEP** (re-measure if the pending count ever backs up) | None. |
| 4 | **`DEFAULT_PROFILE_RESULT_TARGET` 10** | `config/profileResultFloor.js` | Not suppression of existing matches, but of *escalated searching*: at 10, only ~1/3 of the fleet qualifies for backfill; ScholarshipOwl-class products surface dozens-to-hundreds per profile (see competitive brief). Measured awardable distribution 2026-08-01: min 0 · p25 7 · median 14 · p75 26 · max 86. | **LOOSEN** | 10→20 (between median and p75). Floor still escalates SEARCHING only — admission rules, scores and gates untouched; attempts/cooldown bounds unchanged. |
| 5 | **Planner lane selection** (`applicant_type_not_served` / `need_category_not_covered` / `geography_out_of_scope` / `condition_not_declared` / `research_org_only`) | `crawler-os/planner.js` | Across 34 profiles × 167 sources: applicant_type 2,311 · geography 1,583 · need 1,169 · condition 713 · research 33 exclusions. Example: Anastasia 39 selected / 137 excluded. | **KEEP** (with the structural answer below) | None to the gates. The owner's own north star is "determine the need → run the CORRECT crawlers" — targeted selection IS the goal. The recall cost of a lane another profile ran is now answered structurally: whatever ANY lane puts in the catalog is eventually adjudicated for EVERY profile by guardrail #1's sweep, so lane selection stops suppressing *matching* and only scopes *discovery targeting*. |
| 6 | **Match-score floor 8 (pipeline bar) + relevance floor 5** | `config/matchThresholds.js`, `enforceRelevanceFloor` | Bands empirically calibrated against the prod distribution (recalibrated 2026-07-31, PR #1067); canonical rule forbids hand-tuning one bar. | **KEEP** (honesty of the calibrated scale) | None. Recalibrate only via `score-distribution.mjs`. |
| 7 | **Amount/eligibility REJECT gates** (foreign jurisdiction, declared-place, individual award ceiling, stage-of-life, aid preference) | `matchEngine.makeDecision` + scope sweeps | Each shipped with its own prod measurement of a *false-surface* class (618 foreign rows, 684 out-of-area locators, 218 institutional-scale rows, …). These remove claims the profile provably cannot act on — they are precision by classification, exactly the owner's rule. | **KEEP** | None. |
| 8 | **Missing-amount handling** | `enforceAmountEnrichment` chain | Already surfaces-with-label (`none_published` / `not_listed` / "+N sources without listed amounts") rather than rejecting. | **KEEP** (already owner-rule-shaped) | None. |

## The flood (why sweep writes are OFF until the junk chain lands)

Dry run of guardrail #1's sweep against prod, read-only, 2026-08-03T16:51Z —
2,500-row deterministic sample (`ORDER BY md5(id)`) of each golden profile's
never-scored active non-pointer rows, adjudicated by the REAL
`computeMatchDecision`:

| Profile | ACCEPT | REVIEW | REJECT | ACCEPT rate | Projected over full backlog |
|---|---|---|---|---|---|
| Anastasia White | 505 | 1,183 | 689 | 20.2% | ~2,200 new matches |
| Robert White | 483 | 1,185 | 710 | 19.3% | ~2,100 |
| Gilbert McCosh | 333 | 1,061 | 985 | 13.3% | ~1,470 |

The ACCEPTs contain real recall — "Adams Family Foundation Scholarship in
Human Sciences" (76), "Nursing Scholarship Program" (81), "Thomas and Marianne
Weber Family Scholarship" (80) for Anastasia — **and** the exact junk classes
the `fix/qa-36-profile-junk` branch is building classifiers for: "U.S. Embassy
Luanda Public Diplomacy" ACCEPT 11, "U.S. Mission to the United Nations-Geneva
Small Grants" 12, NIH P30/R25 program announcements, federal-register rows
(10 per profile in every sample). The engine ACCEPTs junk on these paths
today; shipping the sweep's writes now would be the #886 flood.

**Sequencing (per charter):** the sweep's machinery ships now, count-only
(`ENFORCE_CATALOG_RESCORE` unset). Its `passesFundabilityGate()` is the single
named choke point where the precision branch's `is_fundable_opportunity()` /
regulatory-notice classifier chain gets consumed; flip `ENFORCE_CATALOG_RESCORE=1`
only after that chain lands there. Until then every boot logs the census
(`would_link` + examples), so the recall payoff stays measured, never guessed.

## Golden-profile baseline (before), 2026-08-03T16:49Z

Engine-adjudicated **awardable** surfaced counts (`surfaced_awardable`,
pointer kinds excluded), via `auditProfileResultCoverage` on prod:

| Profile | surfaced | actionable | **awardable** | never-scored active non-pointer rows |
|---|---|---|---|---|
| Anastasia Nicole White | 144 | 144 | **120** | 10,930 |
| Robert Michael White | 139 | 137 | **115** | 10,933 |
| Gilbert Allen McCosh | 47 | 47 | **20** | 11,030 |
| Dr. John Robert White | 50 | 49 | **21** | 11,028 |

Expected "after" once sweep writes are enabled behind the junk chain: the
table above plus the junk-screened share of each profile's ACCEPT backlog
(upper bound before screening: +2,200 / +2,100 / +1,470). That is a
**projection from the measured dry run, not a claim** — the realized number
must be re-measured after `ENFORCE_CATALOG_RESCORE=1` ships, and will be lower
because the junk chain will (correctly) remove the embassy/regulatory class
from the ACCEPT set.

For the web-lane loosen: at cap 14 each run executed 14 of a p50-61-deep pool;
at 20 each run executes 6 more of the highest-priority truncated queries per
profile per run (arithmetic on the measured pools, not a behavior claim — new
finds still depend on what the searches return).

## What was CHANGED / VERIFIED / UNKNOWN

**CHANGED**: catalogRescoreSweep service + boot step 53 (count-only);
`catalog-rescore-link` in `SURFACED_MATCHER_VERSIONS`; web-lane budgets
env-tunable with defaults 20/8/32; result target 20; env examples regenerated.

**VERIFIED (this session)**: all prod measurements above (timestamps given);
sweep guard tests green (16 tests) and mutation-verified 5 ways with printed
applied/killed verdicts (ACCEPT-only bar, default-off write switch,
fundability choke, pointer predicate, existing-match exclusion — all killed);
`enforceInvariants` suite green at 53 steps; floor/webLane/matchSurfacing
suites green after expectation updates.

**UNKNOWN / pending**: realized recall gain of the sweep (requires the junk
chain + `ENFORCE_CATALOG_RESCORE=1` + post-deploy re-measure of the golden
table); realized yield of the wider query budget (requires nightly runs);
whether the precision branch's classifier will consume `passesFundabilityGate`
as designed (coordinate at rebase).
