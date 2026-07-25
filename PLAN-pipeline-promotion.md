# PLAN v2 — Qualified ⇒ Pipeline (round 2: addresses Sol NO-GO critique in full)

Owner decision (2026-07-20): every match the LIVE engine qualifies lands in the
pipeline automatically. Round-2 revision resolves Sol's 7 blockers; the naive
"floor removal" framing is gone.

## The rule, restated precisely
> There is ONE canonical admission predicate. An active, real (non-synthetic)
> profile's pipeline contains exactly the stored candidates that predicate
> ADMITS; every candidate it does not admit carries a RECORDED reason; the UI
> derives both the pipeline and the "why not" explanations from those recorded
> outcomes — never from a parallel reimplementation.

## Design changes vs v1 (keyed to Sol's blockers)

**B1 — live-rescore totality.** Candidate selection NO LONGER pre-filters on
stored score/decision. Candidates = ALL `profile_opportunity_matches` rows for
the profile not already linked into `grants` AND without a durable terminal
outcome (below). Every candidate gets a FRESH `computeMatchDecision`; the
stored score is display-only. Stale-LOW and stale-REJECT rows that qualify
live are therefore promoted (v1 could never see them).

**B2 — canonical admission predicate.** New `admitToPipeline(db, profile,
candidate, ctx)` in the matching service: composes live rescore + every
retained gate (source allowlist, relevance floor, dup checks, tombstones) by
CALLING the existing gate implementations, and returns a structured outcome
`{admitted, reason, score}` — reasons enumerated (accepted | below_bar |
live_reject | tombstoned | duplicate:<kind> | source_excluded |
relevance_floor | error:<transient>). `saveToProfilePipeline` becomes the
write arm; the sweep AND any future promote path go through the predicate. The
UI "why not" counts come from recorded outcomes grouped by reason — including
above-bar rows other gates rejected (v1's count silently omitted them).

**B3 — durable outcomes = convergence.** New table
`pipeline_promotion_outcomes (profile_id, opportunity_id, outcome, reason,
score, attempted_at, attempts)` (guarded migration, PK profile+opportunity).
Terminal outcomes (promoted, tombstoned, duplicate, source_excluded,
live_reject, below_bar) leave the candidate set; transient errors retry with
attempts-capped cooldown, and candidates are ordered fewest-attempts-first so
permanent failures cannot starve fresh rows (the amount-sweep starvation
lesson applied here by construction). `remaining` is COMPUTED from the DB
(candidates lacking terminal outcomes), not from a loop counter. Staleness:
a terminal below_bar/live_reject outcome is re-openable — cleared when the
profile's sections change (hooked on profile_sections write, same trigger that
invalidates matches today) or by an explicit re-evaluate action, so "terminal"
never means "forever" for facts that can change.

**B4 — tombstones fail CLOSED here.** Inside the sweep, a tombstone lookup
error = outcome `error:transient` (skip, retry later) — never promote on
fail-open. Additionally the enforcer re-runs `reconcileDismissedGrants()` for
affected profiles AFTER promotion, so even a resurrection through some other
path is swept the same boot, not next boot.

**B5 — off the boot path.** The sweep does NOT run inside the sequential boot
invariant chain. It registers as a post-listen async job (kicked
setImmediate after server ready) and a nightly run: per-profile round-robin
fairness, `PROMOTION_BATCH` total-attempt cap per run, per-run time budget,
one summary log line per profile (no per-row log bursts). Boot latency is
untouched.

**B6 — amount-coverage interaction.** (a) Admission order prefers
amount-carrying candidates per profile; (b) BEFORE first enablement, a
report-only preflight run records projected promotions + projected
amount-null count and the sweep publishes it (system_kv) for the morning
report; (c) newly promoted amount-null rows enter the existing amount
enrichment/backfill queues in the same run (enforceGrantCatalogLink →
enforceAmountEnrichment ordering already handles linked rows); (d) the
coverage ratchet's baseline is stepped once with the preflight projection so
convergence cannot read as a wipe. No silent "watch the dashboards".

**B7 — synthetic exclusion is OR, and ordered after expiry.** Exclusion
predicate: `created_by='agent:amy'` OR any synthetic metadata flag OR the
designated-synthetic tag — ANY marker excludes (conservative; corrupted
half-marked rows stay out). The nightly promotion run executes AFTER
`enforceAmySyntheticExpiry` so expired synthetics are gone before scanning.
Tests cover conflicting/missing marker combos.

## Tests (rewritten per Sol's vacuousness findings — each with positive controls)
1. Stale-LOW stored score + live-qualifying → PROMOTED, and the scorer spy
   proves rescore was invoked (fails on v1's stored-score pre-filter).
2. Stale-REJECT stored decision + live-qualifying → PROMOTED (same spy).
3. Stored-above/accepted + live-REJECT (mocked engine) → NOT promoted, outcome
   `live_reject` recorded, scorer invoked.
4. Tombstoned candidate: positive-control twin (identical, no tombstone)
   PROMOTES; the tombstoned one records `tombstoned`. Injected tombstone-query
   failure → `error:transient`, NOT promoted (fails on the fail-open path).
5. Amy synthetics: an otherwise-promotable real-profile twin PROMOTES; each
   marker variant alone (created_by only, flag only, conflicting) is excluded.
6. `remaining` computed from DB state by the TEST independently (seeded
   candidates minus expected terminals) and compared to the sweep's report —
   including permanent-duplicate rows that must not recount as remaining.
7. Duplicate-by-fingerprint (no funding_opportunity_id link) records terminal
   `duplicate:` outcome and leaves the candidate set (fails on v1 forever-loop).
8. UI count derivation: recorded outcomes → grouped reasons; an above-bar row
   rejected by the source allowlist appears in the count (v1 missed it).
9. Boot: server listen completes without the sweep having run (ordering test).

## Rollout
Report-only preflight run first (outcome rows written with `dry_run` marker +
projection published). Owner-visible projection in the morning report. Then
enable (`ENFORCE_QUALIFIED_PROMOTION`, count-only kill switch retained).
Retire `PIPELINE_REFILL_MIN_ROWS` + the Railway stopgap var. UI copy split:
ACCEPT-tier admissions are "qualified"; REVIEW-tier (locators/finders, capped
below auto-add by design) surface as "N more places to look" via SmartMatcher
link — never counted as "didn't qualify".

## ROUND-3 AMENDMENTS (resolving Sol's remaining/new blockers)

**A-B2 (canonical entry point).** `saveToProfilePipeline` REMAINS the sole
public entry point — its signature and every existing caller are untouched. It
delegates internally: its current inline admission checks move INTO
`admitToPipeline`, which it calls first; there is exactly one implementation
and no bare write arm anywhere. The sweep calls `saveToProfilePipeline` like
every other caller, passing an optional `outcomeSink` (new last options arg,
default null) so sweep-driven calls record structured outcomes; user-initiated
calls behave exactly as today (no outcome rows). Static tripwire test: no
module outside the matcher service imports `admitToPipeline` directly.

**A-B3 (staleness without a nonexistent hook).** No reliance on any
profile-write trigger. Every recorded outcome carries the INPUTS' fingerprints
computed inside `admitToPipeline` at decision time:
`profile_facts_hash` (stable hash of the loadProfileContext signals actually
consulted), `policy_version` (source allowlist + relevance floor config hash),
and `opportunity_updated_at`. A terminal outcome is STALE — and the nightly
sweep re-evaluates it — when any recorded fingerprint differs from the current
value. This covers profile edits (any writer, hooked or not), source-policy
changes, and opportunity-data changes with one convergent rule. `tombstoned`
outcomes are cleared by the existing user-restore path (which already re-adds)
and are also re-checked on fingerprint change; `duplicate` outcomes re-check
cheaply (index lookups only) each nightly run.

**A-B6 (ratchet transition, defined).** No baseline rewrite. The preflight
publishes `system_kv promotion_projection = {projected_rows,
projected_null_amounts, started_at}`. The coverage census gains a
COHORT GRACE rule: a row whose promotion outcome row is younger than
`PROMOTION_AMOUNT_GRACE_DAYS` (default 7) and whose amount status is still
unanswered is counted in a separate `promotion_converging` bucket — visible,
never green-washed, excluded from the regression comparison ONLY while inside
the grace window. Idempotent by construction (pure function of row age); no
history mutation; expiry of the window with rows still unanswered = a normal
red finding. The promotion job explicitly enqueues amount work: after each
batch it invokes the existing linked-enrichment pair
(`enforceGrantCatalogLink` → `enforceAmountEnrichment`) scoped to the ids it
just promoted, with its own small budget — no reliance on boot ordering.

**A-NEW-1 (dry-run isolation).** The outcomes table gains `mode TEXT NOT NULL
CHECK (mode IN ('live','dry_run'))`. Eligibility and `remaining` queries
filter `mode='live'` (tested). Enabling the feature DELETES all dry_run rows
first (recorded in the enable log), so a rehearsal can never suppress a live
candidate.

**A-NEW-2 (terminal-outcome invalidation completeness).** Covered by A-B3's
fingerprint rule (profile facts, policy version, opportunity updated_at) plus:
tombstone restoration → existing restore path; grant deletion → the candidate
query's NOT-linked check naturally re-admits when the grant row is gone AND
the prior `promoted` outcome is invalidated by a sweep pass that verifies
promoted outcomes still have their grant row (missing → outcome cleared,
reason logged — sticky DELETES are honored first via tombstone check, so a
user-deleted grant records `tombstoned`, not a re-promotion loop).
