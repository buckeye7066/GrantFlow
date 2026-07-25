# ULTRAPLAN — GrantFlow master build coordination (2026-07-25)

**What this is:** the *coordination layer* over the three build-ready
adversarially-reviewed sub-plans already at the repo root:

- `PLAN.md` — Bug A PROGRAM: de-contaminate the web lane (profile-blind extractor; `WEB_LANE_PROFILE_BLIND`).
- `PLAN-pipeline-promotion.md` — Qualified ⇒ Pipeline (`ENFORCE_QUALIFIED_PROMOTION`).
- `PLAN-portal-credentials.md` — Consentable portal-credential storage + autonomous re-sign-in (`HAMILTON_AUTONOMOUS_RELOGIN`).

This document does NOT re-derive their design (they survived their own Fable↔Sol
rounds — portal-creds reached `CONFIRMED GO` after 7 rounds, the other two are at
round-3 BUILD-READY). It owns the things each plan **cannot see alone**: the
order to ship them, the seams where they collide, the migration ledger that must
be ONE not THREE, and the repo hygiene blocking the runway. Per repo culture
(`docs/canonical_rules.md`, `CLAUDE.md` INVARIANTS), every PR below must pass the
Fable↔Sol `/route` loop **and** `npm run check:prepush` before merge.

**Status:** persisted (D6 DONE 2026-07-25) to local branch `docs/ultraplan-2026-07-25`
under `docs/plans/2026-07-25/`; NOT pushed (push is an explicit owner step). The
editable root copy (`ULTRAPLAN.md` + the three `PLAN*.md`) also remains in the
working tree as untracked files.

---

## 0. Ground truth (verified this session, 2026-07-25)

What's shipped to `main` (recent log #973–#994): auth maintenance login mode,
Anya self-serve chat + profile find + Hamilton session keep-alive (#994),
Hamilton learn-a-portal-wall (#993), Akamai-class bot-wall defeat (#992),
live-login nav-failure handling (#991), scroll-to-workspace (#990),
sam amountCoverage host grouping (#988), crawler duplicate-retry pileup (#987),
admin triggerAll choke-point (#985), Postgres `resolved` boolean fix (#984),
crawler-os coverage telemetry restore (#983), the Fable↔Sol adversarial
repair loop (#974/#975), OTP hardening (#973).

What's in-flight (branches, last touch):
- `fix/pr30-2fa-capture-honesty` (2026-07-21) — **behind its upstream** (= the
  portal-creds PR 3.0 branch, needs merge-forward). This is the plan's stated
  FIRST ship ("security-critical, benefits every flow").
- `feat/weblane-0-3-reality-gate-split`, `feat/weblane-2-1-identity-schema`,
  `feat/weblane-2-2-target-identity` (2026-07-21) — web-lane Phases 0.3 / 2.1 / 2.2.
- `feat/qualified-pipeline-promotion` (2026-07-21) — pipeline-promotion main.
- `feat/amount-enrich-reason` (2026-07-24), `feat/native-billing-gate` (small),
  `feat/amy-flywheel-50`, `feat/login-gap-interview-global`, `feat/ios-build`.

What's detritus (delete-eligible, see §6):
- Dead long-behind `codex/*` (ahead=0, behind 280–305): `codex/fix-post-650-ci`,
  `codex/fix-final-main-ci`, `codex/fix-main-john-email-test`,
  `codex/cursor-audit-targeted-fixes`, `codex/crawler-profile-rules-hamilton-cleanup`.
- `worktree-agent-ac5380a728cd65994` — dangling worktree branch.
- 12 open Dependabot PRs (the `PLAN.md` "6 open" hygiene note is STALE — now 12).

**⚠ AUDITED 2026-07-25 (U0 complete — inferred table below is now VERIFIED).**
`git fetch origin --prune` ran; `origin/main` tip = `22c18a65` (2026-07-24,
deps-dev bump #1013). True branch state vs fresh `origin/main`:

| Branch (plan role) | ahead | behind | Real state |
|---|---|---|---|
| `fix/pr30-2fa-capture-honesty` (portal-creds PR 3.0) | **1** | 24 | **1 checkpoint commit this session (`5682dd06`)** — the 19 formerly-staged-but-uncommitted files (`hamiltonAuthProof.js` new, migration `151_hamilton_session_verification` + PG `0155`, M on hamiltonAutomation/Orchestrator/autopilotEngine/credentialSession/schedule) were verified GREEN via `check:prepush` (full chain, 2026-07-25) and committed to stop the work dangling. Still a DRAFT (not merge-forwarded, not pushed, no `/route` review yet); owning agent may `git reset --soft HEAD~1` to re-stage. |
| `feat/weblane-0-3-reality-gate-split` (web-lane "FIRST PR=0.3") | 1 | 27 | One commit: reality-gate split composition-equivalence test. **VERIFIED first-merge-ready this session**: trial-merge of `origin/main` is CLEAN and the merged tree passed `check:prepush` green (`7fe72708`, `✓ built in 4.73s`). Worktree clean (only `PLAN.md`). |
| `feat/weblane-2-1-identity-schema` (web-lane P2.1) | 2 | 27 | Phase 2.1 identity tables + accessors + a Sol fix-cycle commit. Built + adversarially iterated. Clean worktree. |
| `feat/weblane-2-2-target-identity` (web-lane P2.2) | 4 | 27 | `verified_target_v1` identity policy + 3 fix cycles resolving Sol blockers. Most-iterated of the web-lane series. Clean. |
| `feat/qualified-pipeline-promotion` (pipeline-promotion) | **9** | 27 | Promotion core + scheduling + persisted outcomes + 6 fix commits (atomicity, legacy-contract, dry-residue, serialized runs, env regen). **Most-developed plan branch.** Clean (only `PLAN-pipeline-promotion.md`). |
| `feat/amount-enrich-reason` (adjacent telemetry) | 1 | 9 | Pins last enrich-outcome reason per row (recent 2026-07-24). Not one of the three big plans. |

**Consequences for the ship order (corrects §1):**
1. The three initiatives are NOT equally ready. Two have real committed code
   (web-lane 1+2+4 commits across its phases; promotion 9 commits). Portal-creds
   had ZERO committed work as of the audit — only a staged draft — which this
   session committed as a verified-green checkpoint (`5682dd06`). So "ship PR 3.0
   first" is **gate-ordered but not review-ready**: next action there is *merge-forward
   onto current main + `/route`-review*, not "merge an existing reviewable PR" — the
   checkpoint captured the work but is still 24 behind and unreviewed.
2. **All plan branches are 24–27 commits behind `origin/main`** — each needs a
   merge-forward before review/merge. They share a common ancestor that already
   carried speculative migrations 150–153 (see S3).
3. `origin/main` advanced 24+ commits since the plans forked; the plans' own
   citations to line numbers (e.g. `webLane.js ~304-348`) are from that older base
   and **must be re-verified against main** before any build resumes — the cited
   line ranges have shifted.

**Migration seam S3 — REVISED after verifying the runner (downgraded).** `origin/main`
already contains DUPLICATE migration leading-numbers (SQLite `150`×2, `151`×2;
PG `154`×2, `155`×2): `150_opportunity_identity_tables` +
`150_pipeline_promotion_outcomes` + `151_amount_enrich_env_attempts` +
`151_eva_portfolio_qa` all live on main. So the speculative schema for BOTH big
initiatives **already landed on main ahead of its feature code** (additive, guarded —
the repo's safe pattern). The runner (`backend/db/migrate.js:listSqlMigrations`)
keys migrations by **full filename** in a `_migrations(name UNIQUE)` ledger
(*not* by leading number) and sorts lexicographically by full filename, so
duplicate numbers are **functionally tolerated** — each distinct filename runs
independently. This is **convention drift, not a live bug.** Residual risks: (a)
migrations that depend on a sibling table could run in the wrong lexicographic
order (the two `150_*` create disjoint tables, so safe today); (b) the portal-creds
draft adds a third `151_hamilton_session_verification` — distinct filename, runs
fine, but the numbering drift deepens. **D7 downgraded from "urgent consolidation"
to "add a CI guard that fails on a new duplicate leading-number + a migration
registry"; not blocking.**

---

## 1. The three initiatives (at-a-glance)

| Initiative | Ship position | Self-contained? | Branch home | Reviewer state |
|---|---|---|---|---|
| Portal-creds PR 3.0 (2FA-capture-honesty) + opt-in capture + autonomous re-login | **#1 — first** | YES (Hamilton/login side only) | `fix/pr30-2fa-capture-honesty` (behind upstream) | `CONFIRMED GO` (round 7) |
| Web-lane de-contamination (0.3 → 0.1 → 0.2 → P1 shadow → P2 identity+persist → P3 migration) | **#2** | Catalog/match write-path | `feat/weblane-0-3-*`, `2-1-*`, `2-2-*` | BUILD-READY (round-3 pins) |
| Pipeline-promotion (preflight → enable) | **#3** | Catalog/match/pipeline/amount | `feat/qualified-pipeline-promotion` | BUILD-READY (round-3 amendments) |

Portal-creds ships first by its own plan AND by dependency analysis — it touches
none of the catalog/match/pipeline seam the other two share, so it carries zero
cross-plan blast radius and it's a security fix. Web-lane precedes
pipeline-promotion at scale because promotion's "not-linked-into-grants" and
duplicate-fingerprint logic should run over the de-contaminated, alias-aware
catalog (Phase 2 lands identity aliases), not the legacy title-first key.

---

## 2. Cross-plan seams (the value of coordinating instead of racing them)

These are the interactions the individual PLANs cannot adjudicate. Each is a
concrete risk that must be resolved at the seam, not in one plan alone.

### S1 — Catalog write-path seam (web-lane P2 ↔ pipeline-promotion)
Web-lane Phase 2 introduces `opportunity_identity_aliases` +
`opportunity_identity_conflicts` and a blind-specific persister with a strict
field-authority matrix. Pipeline-promotion's candidate query is
`profile_opportunity_matches` rows "not already linked into `grants`" and its dup
guard is "duplicate-by-fingerprint (no `funding_opportunity_id` link)".
**Risk:** once aliases exist, two candidate rows can be the same real-world
opportunity under different keys; promotion's dup/relink detection must consult
the alias table or it can promote a duplicate (and its `duplicate:` terminal
outcome test 7 must be re-validated against aliased rows).
**Seam rule:** web-lane Phase 2 (2.1 schema + 2.2 identity policy + 2.4 transactional
dual-read persister) lands BEFORE pipeline-promotion's ENABLE. The preflight
(dry-run, no live writes) may run earlier for projection telemetry — it writes
nothing into `grants` and is alias-insensitive.

### S2 — Amount-coverage ratchet seam (web-lane ↔ pipeline-promotion)
Both initiatives feed `pipeline.amountCoverage`, which the CLAUDE.md amount-status
invariant now defines as: census counts REAL pipeline only, fails only on
`unanswered_unreadable`, and `unanswered_no_catalog_row` = backlog (the
grant↔catalog link census). Web-lane's `enforceGrantCatalogLink` +
`enforceGrantDirectAmountEnrichment` reduce `unanswered_no_catalog_row`;
pipeline-promotion's B6/A-B6 admits amount-null candidates and steps a
`promotion_converging` cohort grace so new null rows never read as a wipe.
**Risk:** shipping both uncoordinated trips the ratchet — the preflight's
projection baseline (A-B6) must be stepped AGAIN if web-lane link-enrichment runs
in the same window, or convergence reads as the wipe the ratchet exists to catch.
**Seam rule:** pipeline-promotion's `ENFORCE_QUALIFIED_PIPELINE` enable is gated
on (a) web-lane Phase 2 link semantics being live AND (b) a single coordinated
ratchet-baseline step that accounts for BOTH the link census reduction and the
promotion cohort — one projection, not two. The ratchet degrades to "census
unavailable", never to "fine" (per invariant).

### S3 — Migration ledger seam (ALL THREE)
Each plan adds guarded migrations:
- portal-creds: `hamilton_consent_events`, `credential_metadata`, `credential_id`
  on `hamilton_saved_sessions`, `pending_capture_credentials`, plus a `kind` CHECK
  gain for `consent_revoked`.
- web-lane P2: `opportunity_identity_aliases`, `opportunity_identity_conflicts`.
  P3: repoints ≥11 opportunity-referencing tables.
- pipeline-promotion: `pipeline_promotion_outcomes(mode, profile_facts_hash,
  policy_version, …)`.

**Risk:** three uncoordinated migration streams can collide on (a) numbering/timing
across SQLite ↔ PG parity (the `fo.url` schema-drift trap, #946/#954 — prod has a
bare `url` column SQLite lacks), (b) the provenance/`record_origin`/`page_fact_`
columns the web-lane persister writes vs the columns promotion reads, and
(c) Postgres-vs-SQLite TYPE drift (the #139/143 lesson: `amount_confidence:'high'`
into a REAL column passed SQLite, failed PG).
**Seam rule — OWNER DECISION D7:** ONE consolidated migration ledger
(`backend/db/migrations/` + `backend/db/postgres/migrations/`), with a parity
totality check that each new column's TYPE is asserted in a test (SQLite will not
catch it). Each PR keeps its own guarded, separately-applied migrations, but the
*numbering space and the parity test* are shared. Never add OS-schema DDL to the
`ensureOsTables` hot path (per web-lane plan, breaks flag-off SQL equivalence).

### S4 — "measure-the-world vs us" metric seam
Pipeline-promotion B7 excludes Amy synthetics via an OR across
`created_by='agent:amy'` / synthetic flags / designated tag, ordered AFTER
`enforceAmySyntheticExpiry`. The amount-status invariant already excludes
synthetics from BOTH the headline and the census (NON_SYNTHETIC_PIPELINE) and has
its own `amount_recall_miss`. **Seam rule:** the synthetic-exclusion predicate is
the SAME function in both — do not reimplement it in promotion; import the
canonical `NON_SYNTHETIC_PIPELINE`/`isAmySynthetic` predicate. A synthetic-exclusion
differential test asserts both paths agree.

---

## 3. Risk register (repo-culture hazards — non-negotiable)

| # | Hazard | Enforced by | ULTRAPLAN rule |
|---|---|---|---|
| R1 | Migration parity — superseding a system must PROVE coverage, not just cutover (the 2026-07 crawler-os stranded-lanes lesson) | `docs/canonical_rules.md` §MIGRATION PARITY + totality tests | Phase 3 web-lane cutover ships a mechanical parity check enumerating the OLD reachable surface vs new; no "old code stopped" claims |
| R2 | Invariants enforced at ONE choke point, not per-call | `backend/startup/enforceInvariants.js` + `ensureSchemaInvariants.js` | New promotion/credential/identity invariants get a row in the `CLAUDE.md` INVARIANTS table + a guard test + a boot-net call, never a scattered check |
| R3 | PG-vs-SQLite type drift | migrations 139/0143 lesson | Any PR persisting a value into an existing column asserts its TYPE in a test (SQLite is typeless and will not catch it) |
| R4 | "Measure-the-world" metric trap | amount-status invariant (coverage must measure US, not the universe of funders) | Every new ratchet/census asserts on a denominator carved to real-pipeline; a finding that can never go green is noise and is rewritten, not shipped |
| R5 | Adversarial-review gate | repo culture (Fable↔Sol; commits #974/#975) | Every PR below runs the `/route` loop to `CONFIRMED GO` + `npm run check:prepush` before merge; direct-to-main only via the owner-toggle path (#975) |
| R6 | Live-editing lock | `.agent-edit-lock` (absent now) | Re-check before each work session; never push while locked. Cursor honors the same lock |
| R7 | Untracked plan loss | — | D6 commits `PLAN*.md` + this file |

---

## 4. Owner decisions required (recommended defaults — non-blocking)

- **D1 — Branch strategy.** Land the three initiatives as their EXISTING sub-PR
  series, each through its own review loop. *Recommended:* YES (matches plan
  design: "each PR independently safe, flag-gated, additive"). Rejected: one giant
  integration branch (unreviewable, reverts lose unrelated work).
- **D2 — Web-lane Phase 3 migration timing.** Separate manually-applied script,
  separately reviewed, AFTER a canary on real profiles. *Recommended:* defer until
  0.3 / 0.1 / 0.2 / P1 / P2 are all green on canary profiles, then author the
  migration last, dry-run on a DB COPY, apply with owner sign-off. Never auto-merge;
  never on the flag-off path.
- **D3 — Pipeline-promotion enable.** Report-only preflight first (outcome rows
  with `dry_run` marker + projection published to `system_kv promotion_projection`,
  owner-visible in the morning report), THEN enable behind
  `ENFORCE_QUALIFIED_PROMOTION` with the count-only kill switch retained.
  *Recommended:* YES (matches B5/B6/A-NEW-1).
- **D4 — Hamilton autonomous re-login canary.** `HAMILTON_AUTONOMOUS_RELOGIN`
  default OFF for one canary cycle. StudentAid stays MANUAL-ONLY (registry
  policy, not an oversight). *Recommended:* YES (matches plan; manual-only is a
  legal/ToS posture — needs an explicit owner registry edit to lift).
- **D5 — Branch hygiene now.** Delete the dead `codex/*` (ahead=0, behind 280+)
  + `worktree-agent-*`; thesquash-merged `fix/*` whose PRs already shipped
  (#983/#988/#990/#992). *Recommended:* YES (safe; verify each with
  `git log origin/main..branch --oneline` after fetch to confirm zero genuine
  commits). Triage Dependabot: security-relevant first (setup-node action,
  eslint, typescript, babel/parser), then the dep-group batches.
- **D6 — Persist the plans.** Commit `PLAN.md`, `PLAN-pipeline-promotion.md`,
  `PLAN-portal-credentials.md`, and this `ULTRAPLAN.md` into git (e.g.
  `docs/plans/2026-07-25/`) on a new `docs/ultraplan-2026-07-25` branch —
  additive, docs-only, no behavior. *Recommended:* YES — they are currently
  UNTRACKED and will be lost on a careless `git clean` / branch reset. They are
  the most valuable artifacts in the repo right now.
  **DONE 2026-07-25** — branch `docs/ultraplan-2026-07-25` created from
  `origin/main (22c18a65)`, all four docs committed under `docs/plans/2026-07-25/`.
  Not pushed.
- **D7 — Migration ledger.** Consolidate the three migration streams into ONE
  shared numbering + parity-test space. *Recommended:* YES (see S3). This is the
  single most likely silent-failure point if left to three independent authors.

---

## 5. Unified build sequence

Phase numbers are the web-lane's. Ear gate = `/route` Fable↔Sol `CONFIRMED GO` +
`npm run check:prepush`. Migrations honor the seam rules S1–S4 and the R3 type test.

**PHASE U0 — Build-state reconciliation audit (no code)**
- A1 `git fetch origin` then diff each plan-tied branch vs `origin/main` — confirm
  what's genuinely built vs stubbed (the ahead/behind snapshot is unreliable
  against stale local `main`).
- A2 Open `feat/qualified-pipeline-promotion`, the three `feat/weblane-*`,
  `fix/pr30-2fa-capture-honesty`, `feat/amount-enrich-reason` against origin/main;
  tabulate: files touched, migrations present, flag state, tests passing.
- A3 Re-run `npm run check:prepush` on `main` to establish the green baseline;
  if red, that's critical-fix-first (a red baseline invalidates every plan gate).
- Deliverable: a one-page branch/migration/flag reconciliation table. THIS is the
  evidence the rest of the plan grounds in.

**PHASE U1 — Portal-credentials (ship first: fewest cross-plan deps, security-critical)**
Sequence per its own plan (confirmed GO): PR 3.0 (2FA-capture-honesty pre-fix incl.
A6-1 server-probe-sole-authority import verification) → PR 3.1 (storage model +
migrations + capture API) → PR 3.2 (opt-in UI) → PR 3.3 (keep-alive re-login rung +
quarantine + registry IdP allowlist, `HAMILTON_AUTONOMOUS_RELOGIN` default OFF).
First action: merge-forward `fix/pr30-2fa-capture-honesty` (it's behind upstream).

**PHASE U2 — Web-lane de-contamination (resolves S1/S2/S3 catalog side before promotion scale)**
First PR = `feat/weblane-0-3-reality-gate-split` (pure mechanical refactor: split
global reality checks from profile policy; `enforceReality()` composes both
EXACTLY as today; change no callers, no DB — per the plan's "FIRST PR = 0.3 only").
Then 0.1 (durable page-fact provenance + tri-state flags) → 0.2 (content-addressed
page-fact cache, additive) → Phase 1 shadow/dry-run (no live writes) → Phase 2
four sub-PRs (2.1 schema+accessors → 2.2 target-identity policy → 2.3 promotion
handoff → 2.4 transactional dual-read/quarantine persister). Phase 3 migration =
D2, last, manual.

**PHASE U3 — Pipeline-promotion (gated on U2 Phase 2 + S2 ratchet coordination)**
Report-only preflight FIRST (writes `dry_run` outcome rows + publishes
`system_kv promotion_projection`), owner-visible in the morning report. Then
enable behind `ENFORCE_QUALIFIED_PROMOTION` (count-only kill switch retained),
retire `PIPELINE_REFILL_MIN_ROWS` + the Railway stopstop var, with the S2
single-coordinated ratchet baseline step. UI copy: ACCEPT-tier admissions =
"qualified"; REVIEW-tier locators = "N more places to look" via SmartMatcher link,
never "didn't qualify" (the locator rule).

**PHASE U4 — Repo hygiene (interleave; safe any time after U0 audit)**
- Delete dead `codex/*` + `worktree-agent-*`; confirm zero genuine commits first.
- Delete squash-merged `fix/*` whose PRs already shipped.
- Triage 12 Dependabot PRs (security-relevant first).
- Refresh the STALE "6 open Dependabot PRs" note in `PLAN.md` (now 12).

---

## 6. First-session action list (executable today, in order)

1. `git -C ~/GrantFlow fetch origin --prune` (refresh stale local `main` + drop
   gone remote branches).
2. Build-state audit (U0): for each plan-tied branch,
   `git log --oneline origin/main..<branch>` and a `--stat`; record the
   reconciliation table.
3. `npm -C ~/GrantFlow run check:prepush` on `main`; if red, stop — the
   baseline is broken and every plan gate is invalid until it's green.
4. **Owner decision D6** — create `docs/ultraplan-2026-07-25` branch, move
   `PLAN.md`/`PLAN-pipeline-promotion.md`/`PLAN-portal-credentials.md` + this
   `ULTRAPLAN.md` into `docs/plans/2026-07-25/`, commit (docs-only).
5. **Owner decision D5** — delete dead `codex/*` + `worktree-agent-*`
   (`git branch -D`, or `-d` to refuse-if-unmerged).
6. Begin U1: merge-forward `fix/pr30-2fa-capture-honesty` onto current main; run
   the `/route` loop on PR 3.0 to `CONFIRMED GO`; ship it first.

---

## 7. Verification protocol (every PR — do not skip)

1. `/route` Fable↔Sol adversarial loop → `CONFIRMED GO` (the repo's own bar;
   portal-creds needed 7 rounds — budget for ≥3 on the web-lane identity work).
2. `npm run check:prepush` green (auth-middleware + profile-guards +
   profile-metadata + runtime-imports + env-examples + lint + typecheck + build).
3. Migration-parity totality test if the PR supersedes/represents a subsystem
   (R1) — enumerate OLD reachable surface, assert NEW covers each or lists an
   exclusion with a reason.
4. **R3** — if a column receives a new value, assert its TYPE in a test
   (SQLite will not catch a REAL/TEXT mismatch; only PG will).
5. Invariant choke-point (R2) — new rule => `enforceInvariants.js` row + guard
   test + boot net, never a per-call check.
6. Metric honesty (R4) — new ratchet/census denominator carved to real pipeline;
   a finding that can never go green is rewritten, not shipped.
7. Direct-to-main only via the owner adversarial-repair toggle path (#975);
   default goes through PR review.

---

## 8. Honest status — what this ULTRAPLAN verified vs left open (post-audit 2026-07-25)

**VERIFIED this session (no longer gaps):**
- ✅ Branch build-state — every plan-tied branch's actual commits + worktree WIP
  inspected (see §0 verified table). Portal-creds = staged draft captured as a verified-green checkpoint commit this session; web-lane
  0.3/2.1/2.2 = 1/2/4 commits; promotion = 9 commits; amount-enrich-reason = 1.
- ✅ Migration ledger — the runner is filename-keyed (`_migrations(name UNIQUE)`),
  so duplicate leading-numbers on `origin/main` (150×2, 151×2 SQLite; 154×2,
  155×2 PG) are FUNCTIONALLY TOLERATED. S3/D7 downgraded to a CI-guard +
  registry; not a live bug (see §0 "Migration seam S3 — REVISED").
- ✅ `check:prepush` baseline on `origin/main` — ran to green this session in a
  detached throwaway worktree at `22c18a65`: the full chain (auth-middleware +
  profile-guards + profile-metadata + runtime-imports + env-examples + lint +
  typecheck + `vite build`) exited 0 with `✓ built in 5.57s` and ZERO
  error/fail lines. The merge target is healthy TODAY. Each sub-plan branch
  (U1/U2/U3) must merge-forward to `22c18a65` and re-run `check:prepush` GREEN
  before the owner pushes — a red there signals the ~24-27-commits-behind merge
  gap closing badly, NOT a pre-existing target problem (the target is proven clean).
- ✅ Merge-readiness per branch (trial merge of `origin/main` into each branch's
  committed tip in a detached throwaway worktree — non-colliding with the
  branch's own worktree, discarded after), done 2026-07-25:
  | Branch | +ahead | Merge `origin/main` | Conflict files |
  |---|---|---|---|
  | `feat/weblane-0-3-reality-gate-split` | +1 | ✅ CLEAN | none | — **build-verified GREEN**: `check:prepush` on the merged tree (`7fe72708` = `0e6ceafc`+`22c18a65`) exited 0, `✓ built in 4.73s`. VERIFIED first-merge-ready. |
  | `feat/weblane-2-1-identity-schema` | +2 | ⚠ conflict | `backend/db/schema.sql` — one region, lines ~4060–4191 (HEAD side empty; origin/main inserted a ~130-line schema block). Likely "take theirs", but owning agent must confirm this branch's identity-table additions aren't interleaved in that range. |
  | `feat/weblane-2-2-target-identity` | +4 | ✅ CLEAN | none |
  | `feat/qualified-pipeline-promotion` | +9 | ⚠ conflict | `sam/samRegistry.js`, `startup/enforceInvariants.js`, `tests/enforceInvariants.test.js`, `tests/pipelineAmountCoverageRatchet.test.js` |
  | `fix/pr30-2fa-capture-honesty` | +1 | n/a | checkpoint committed this session (`5682dd06`): 19 staged files verified green via `check:prepush` + committed; working tree now clean. Still needs merge-forward + green re-check + `/route` review; NOT pushed. |
  Worktree liveness (2026-07-25): the `pr30` + `weblane-0.3` worktrees' last
  source edit was **2026-07-21** (4 days stale); `.agent-edit-lock` absent. The
  plan-tied worktrees appear DORMANT, not actively written. Still — the
  committed branches ARE checked out in those worktrees, so the merge-forward
  must be driven by the owning agent or after the worktree is freed; this
  readiness report was produced non-collidingly and does NOT touch them.
  **KEY FINDING — the promotion conflict IS seam S2 verified**: all four
  conflict files are the INVARIANTS-enforcer + amount-coverage-ratchet surface.
  `origin/main` landed the catalog-link / amount-adapter / portal-URL-rescue
  enforcer rows (the heavy CLAUDE.md INVARIANTS updates) on the SAME files the
  promotion plan touches for its outcomes table. This is a real semantic
  overlap, not a text conflict — the promotion outcomes' exemption from the
  amount-coverage denominator (S2) must be resolved by the owning agent with
  design intent, not auto-merged.

**Still open (deliberately — need prod or owner input):**
- Prod metric baselines (`web_parity_benchmark`, `pipeline.amountCoverage`,
  `promotion_projection` doesn't exist yet) — needed to assert the S2 ratchet step.
- CVE/severity of the 12 Dependabot PRs — triage in U4, not assumed here.
- The `feat/amy-flywheel-50` (ahead=2, behind=161), `feat/login-gap-interview-global`
  (ahead=1, behind=192), `feat/ios-build` (ahead=1, behind=168) branches — small
  and far behind `origin/main`; NOT mapped to any of the three plans. U0 A2 should
  decide whether alive or abandonable. (None has a plan-tied worktree in the 24-
  worktree set.)
- Branch deletion (D5) was WITHDRAWN — the `codex/*` branches the original D5 named
  "dead" all have ACTIVE worktrees (`C:/tmp/grantflow-*-fix`); deleting their
  branches would break live agents. Do NOT delete until those worktrees are gone
  and the branches re-confirm as `--merged origin/main`.
- The plans' own in-file citations to line numbers (e.g. `webLane.js ~304-348`)
  are from a base 24+ commits behind `origin/main` — re-verify the cited ranges
  against current main before resuming any build.
- `fix/portal-card-session-mask` (worktree `C:/Users/firer/gf-portal-session`;
  NOT one of the three plans — adjacent portal-identity work) — **found dangling
  via the 2026-07-25 finish-unfinished-work pass**: 2 modified files
  (`backend/services/hamilton/profilePortalIndex.js` + its test), last edit
  2026-07-22 22:12 (~3 days dormant), branch tip `fc2c92e6` (#1007) 2026-07-22.
  The `hasReadyIdentity` code fix is sound by inspection (resolves the session
  always and returns both flags instead of short-circuiting on the credential)
  and does NOT regress the 24 existing tests, but the **new regression test
  FAILS** — `expected undefined to be 'needs_user'`. Root cause: the test sets up
  a *pipeline-derived* portal (a `scholarships.com` grant), and `getProfilePortals`
  attaches `autopilotState`/`cantAutoMerge` only via `buildProcessTile` for gated
  PROCESS tiles (FAFSA/College Board/grants.gov/state benefits/school), NEVER to
  derived pipeline/college/identity portals — so `before.autopilotState` is
  undefined. NOT checkpoint-committed: a RED test breaks the "complete it = VERIFIED
  finish, never commit unverified work" floor. Completing requires the owning
  agent's design intent — **(A)** fix the test: assert on the derived-portal shape
  (`hasSession`/`status`) or set up a process tile; vs **(B)** extend
  `getProfilePortals` to decorate derived portals with `autopilotState`/
  `cantAutoMerge` (the test describes the intended end-state; `hasReadyIdentity`
  is only step 1). **SEEK GREEN LIGHT on A vs B before committing.** Branch is
  local, not pushed; `.agent-edit-lock` absent.
- `codex/crawler-profile-rules-hamilton-cleanup` worktree WIP
  (`C:/tmp/grantflow-pr650`) — the branch is already listed as delete-eligible
  detritus (§0) and D5 is WITHDRAWN for its active worktree, but the worktree
  additionally holds **238 uncommitted modified/deleted files** (config, routes,
  migrations, tests, + legacy-crawler / `create-kathy.mjs` deletions) with last
  commit AND last dirty-file edit both **2026-06-26 (~29 days dormant)**. Another
  agent's month-old design-intent WIP: DO NOT commit (carve-out), DO NOT delete
  worktree/branch. Report-only; owner decides checkpoint / resume / abandon.
  (Subsumes the stale "24-worktree set" note — the worktree set observed
  2026-07-25 is 23.)

---

*Authored 2026-07-25 as the coordination layer over `PLAN.md`,
`PLAN-pipeline-promotion.md`, `PLAN-portal-credentials.md`. The sub-plans own
their design; this owns their order, seams, and runway. Persisted locally to
the `docs/ultraplan-2026-07-25` branch under `docs/plans/2026-07-25/` (D6, done
2026-07-25); NOT pushed — push is an explicit owner step.*
