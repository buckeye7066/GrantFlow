/**
 * profileResultFloor.js — the PER-PROFILE RESULT FLOOR: how many real funding
 * results GrantFlow should have found for one profile before it stops looking
 * harder, and the bounded ledger that decides when to try again and when to
 * admit the honest answer is "there are only N".
 *
 * THE OWNER RULE (2026-08-01, third clause of the crawler goal):
 *   "They will add to the database returns that fall below the profile's
 *    requested result number."
 *
 * ── WHAT WE COUNT, AND WHY IT IS NOT WHAT WE USED TO COUNT ──────────────────
 *
 * A floor already existed: `MIN_HEALTHY_SURFACED = 3` in
 * `services/coverageAudit/profileResultCoverageAudit.js`, judged against
 * `surfaced_actionable` (qualifies for display, not a templated geo-stub, not
 * past deadline). Measured read-only in prod 2026-08-01 across all 33 real
 * (non-Amy) profiles, that bar flags **0 of 33**: every profile reads 24–190
 * "results".
 *
 * It reads that way because a DIRECTORY is counted as a result. CLAUDE.md is
 * explicit that a locator "is a pointer, never an award" — it promises a place
 * to look. Of the 7,009 surfaced match rows in prod, **3,924 are `directory`**.
 * Counting them as results is how a profile with nothing it can apply to reads
 * as fully served:
 *
 *   Demo General Support Persona — 25 qualifying, 25 actionable, **0 awardable**
 *   William        — 24 qualifying, 24 actionable, **0 awardable**
 *
 * Both sit above `MIN_HEALTHY_SURFACED`. Melissa was in fact "healed" by the
 * nightly sweep on 2026-08-01 (2 → 4 actionable) and is now considered healthy
 * while holding **zero** rows that name money she could receive.
 *
 * So the count this module governs is the AWARDABLE count:
 *
 *   surfaced (`config/matchSurfacing.SURFACED_MATCHER_VERSIONS`)
 *     ∧ catalog row active
 *     ∧ `qualifiesForDisplay(row, DEFAULT_MIN_SCORE)`   ← the canonical display floor
 *     ∧ NOT a templated geo-stub  ∧ NOT past deadline   ← the existing actionable rule
 *     ∧ NOT a POINTER kind (`config/opportunityKindClasses.isPointerKind`)
 *
 * A BENEFIT program (Pell, SSI, LIHEAP) COUNTS — it publishes no fixed figure
 * but it IS the thing you apply to, and `opportunityKindClasses` says so in its
 * own docblock. Only pointers are excluded. Nothing here lowers a bar: the
 * display floor, the engine's decision and every scope gate are unchanged. This
 * is a stricter DENOMINATOR for "is this person served", never a looser
 * ADMISSION rule.
 *
 * ── WHERE THE NUMBER LIVES, AND WHY NOT ON THE PROFILE ──────────────────────
 *
 * It is a CONFIG value with a per-profile override held in the ledger, NOT a
 * `PROFILE_SCHEMA` field. Schema fields default to SCORED
 * (`config/profileSchema.isFieldScored`) — they enter the matcher's data-point
 * inventory and the keyword miner, and `match_score` is literally
 * "matched profile data points ÷ total data points". Minting a profile field to
 * hold a service level would therefore change every profile's match score to
 * store a number that is not a fact about the person.
 *
 * ── THE TRAP THIS MODULE IS BUILT AGAINST ───────────────────────────────────
 *
 * A quota is an incentive to manufacture junk. This repo's worst failures came
 * from making a number go green (#886: locators forced to ACCEPT to fill a
 * recommendation list → 56 false positives). So the floor may ONLY ever cause
 * more SEARCHING. It may never widen an admission rule, relax a score, admit a
 * pointer, or reach past an eligibility gate. Filling the number with rows a
 * family would not recognise as applying to them is strictly worse than an
 * honest shortfall — if a profile has 12 real sources, the answer is 12.
 */

/**
 * THE GLOBAL DEFAULT — every profile gets a floor with zero configuration.
 *
 * 10, chosen against the measured prod distribution of AWARDABLE results over
 * all 33 real profiles (2026-08-01):
 *
 *   min 0 · p25 7 · median 14 · p75 26 · max 86
 *   below 3: 2/33 · below 5: 5/33 · below 8: 9/33 · **below 10: 11/33** ·
 *   below 14: 17/33 · below 20: 19/33
 *
 * (That percentile row is a raw-SQL snapshot. Running THIS module's own code
 * against a full prod replica minutes later reported **12 of 33** below 10 —
 * live data moves between snapshots, and the replica figure is the
 * authoritative one. The shape of the argument is unaffected.)
 *
 * 10 sits above p25 and below the median: it names the under-served THIRD of
 * the fleet without declaring the median profile broken. At the median (14)
 * half the fleet would sit in permanent backfill; at 3 the bar ratifies
 * "zero awards + 25 directories" as served, which is the defect. Ten real
 * sources is also a shortlist a household can actually work through.
 *
 * It is deliberately well clear of `MIN_HEALTHY_SURFACED` (3), which stays what
 * it is: the "this profile is BROKEN" alarm, not a target.
 *
 * RAISED 10 → 20 (2026-08-03, recall-guardrail audit / owner directive:
 * "a free Google search gets better results than GrantFlow ever has"). The
 * competitive bar moved: ScholarshipOwl-class products surface a match list in
 * the dozens-to-hundreds from one profile, and the owner's rule is that
 * precision is achieved by classifying junk out, never by declaring a small
 * number "served". Against the 2026-08-01 measured awardable distribution
 * (min 0 · p25 7 · median 14 · p75 26 · max 86), 20 sits between the median
 * and p75: roughly the under-served two-thirds of the fleet gets escalated
 * SEARCHING (never escalated admission — the trap doc above is unchanged, and
 * the attempts/cooldown bounds make backfill finite). A profile whose honest
 * ceiling is lower still converges to an evidenced `exhausted` verdict; the
 * floor never manufactures a row.
 */
export const DEFAULT_PROFILE_RESULT_TARGET = 20

/** Clamp bounds. A target of 0 disables the floor; >50 is not a real shortlist. */
export const MIN_PROFILE_RESULT_TARGET = 0
export const MAX_PROFILE_RESULT_TARGET = 50

/** system_kv key holding the floor ledger (targets + per-profile attempt state). */
export const RESULT_FLOOR_KV_KEY = 'profile_result_floor_state'

/**
 * How many escalated discovery attempts a short profile gets before the honest
 * verdict is recorded. Mirrors `AMOUNT_ENRICH_MAX_ATTEMPTS` (3): enough for a
 * different pass to find something, few enough that a genuinely narrow niche is
 * not re-crawled nightly forever.
 */
export const RESULT_FLOOR_MAX_ATTEMPTS = 3

/**
 * After exhaustion, how long before the profile is eligible again. 14 days
 * matches the `conditionSourceSearch` cooldown — long enough that the catalog
 * and the open web have genuinely moved.
 */
export const RESULT_FLOOR_COOLDOWN_DAYS = 14

/**
 * Catalog growth (in active rows) that counts as a MATERIAL change to the world
 * and re-opens an exhausted profile before its cooldown elapses. Bucketed so
 * ordinary nightly churn does not reopen everything every boot.
 */
export const RESULT_FLOOR_CATALOG_DRIFT_STEP = 500

/** Ledger outcomes. `transient` never burns an attempt — the #944/#1006 rule. */
export const FLOOR_OUTCOME = Object.freeze({
  /** The pass ran and added at least one awardable result. */
  ADDED: 'added',
  /** The pass ran, searched, and found nothing new. Burns an attempt. */
  NO_NEW_RESULTS: 'no_new_results',
  /** The pass could not run (crawl error, outage, budget). Burns NOTHING. */
  TRANSIENT: 'transient',
  /** Attempts spent without reaching the target — the honest verdict. */
  EXHAUSTED: 'exhausted',
})

function clampTarget(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_PROFILE_RESULT_TARGET, Math.min(MAX_PROFILE_RESULT_TARGET, Math.round(n)))
}

/**
 * The FLEET default: `PROFILE_RESULT_TARGET` env, else the constant. Read at
 * call time (never frozen at import) so a Railway variable change takes effect
 * on the next boot without a code change.
 */
export function resolveFleetResultTarget(env) {
  // The literal `process.env.PROFILE_RESULT_TARGET` read is deliberate: the
  // env-example generator scans for that exact shape, and a knob the owner is
  // meant to turn must appear in the checked-in templates. Tests pass their own
  // object and are fully isolated from the real environment.
  const source = env ?? { PROFILE_RESULT_TARGET: process.env.PROFILE_RESULT_TARGET }
  const fromEnv = clampTarget(source.PROFILE_RESULT_TARGET)
  return fromEnv === null ? DEFAULT_PROFILE_RESULT_TARGET : fromEnv
}

/**
 * This profile's requested result number: its ledger override if one is set,
 * else the fleet default. A garbage override is IGNORED (falls back), never
 * coerced — `Number(null)` is 0 and 0 would silently disable the floor for that
 * profile (the `Number.isFinite(null)` class, #1069/portal-lifetime).
 *
 * @param {string} profileId
 * @param {{targets?: Record<string, number>}|null} ledger
 */
export function resolveProfileResultTarget(profileId, ledger = null, env) {
  const raw = ledger?.targets?.[String(profileId ?? '')]
  if (raw !== null && raw !== undefined && raw !== '') {
    const override = clampTarget(raw)
    if (override !== null) return override
  }
  return resolveFleetResultTarget(env)
}

/**
 * A stable description of the world this profile's verdict was reached in. When
 * it changes, an "exhausted" verdict is no longer about today's world and the
 * profile is re-opened.
 *
 * Deliberately does NOT include `profiles.updated_at`: CLAUDE.md records that
 * 35 of 39 prod rows share one second (a bulk sweep), so keying on it would
 * reopen every profile on every boot — an alert that can never go green.
 */
export function buildFloorFingerprint({ target, activeCatalogCount = 0 } = {}) {
  const bucket = Math.floor(Math.max(0, Number(activeCatalogCount) || 0) / RESULT_FLOOR_CATALOG_DRIFT_STEP)
  return `t${Number(target) || 0}:c${bucket}`
}

/**
 * Days since an ISO timestamp. An UNPARSEABLE stamp returns 0, not Infinity:
 * "we cannot read when this happened" must never read as "infinitely long ago"
 * and authorize a reopen — that is how a bound turns back into the infinite
 * nightly retry it exists to stop (the `Number(null) is finite` class, one door
 * over). A corrupt stamp is re-written by the next observation, and the drift
 * path can still reopen the profile in the meantime.
 */
function daysSince(iso, nowMs) {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return 0
  return (nowMs - t) / 86400000
}

/**
 * PURE: may this profile be given another escalated discovery pass right now?
 *
 * Returns `{eligible, reason, attempts, escalation}`. `escalation` is the
 * 1-based level of the pass about to be made — it is what makes a retry a
 * DIFFERENT pass rather than the same one again (the defect in the existing
 * autoheal, which re-ran `runProfileDiscoveryLive` with identical arguments).
 *
 * @param {object|null} entry     the profile's ledger entry
 * @param {object} ctx            { fingerprint, nowMs, maxAttempts, cooldownDays }
 */
export function evaluateFloorEligibility(entry, {
  fingerprint,
  nowMs = Date.now(),
  maxAttempts = RESULT_FLOOR_MAX_ATTEMPTS,
  cooldownDays = RESULT_FLOOR_COOLDOWN_DAYS,
} = {}) {
  const prev = entry && typeof entry === 'object' ? entry : {}
  const drifted = Boolean(fingerprint) && Boolean(prev.fingerprint) && prev.fingerprint !== fingerprint
  const cooledDown = prev.exhausted_at ? daysSince(prev.exhausted_at, nowMs) >= cooldownDays : false

  // A recorded verdict is about the world it was reached in. Material catalog
  // growth, a changed target, or the cooldown elapsing all re-open it — and
  // re-opening RESETS attempts, because the next pass is a genuinely new
  // question, not a fourth try at the old one.
  if (prev.exhausted_at && (drifted || cooledDown)) {
    return { eligible: true, reason: drifted ? 'reopened_drift' : 'reopened_cooldown', attempts: 0, escalation: 1 }
  }
  if (prev.exhausted_at) {
    return { eligible: false, reason: 'exhausted', attempts: Number(prev.attempts) || 0, escalation: 0 }
  }

  const attempts = Number(prev.attempts) || 0
  if (drifted && attempts > 0) {
    return { eligible: true, reason: 'reopened_drift', attempts: 0, escalation: 1 }
  }
  if (attempts >= maxAttempts) {
    // Exhaustion is DECIDED here and RECORDED by applyFloorAttempt — so a
    // profile can never sit at max attempts forever without a verdict.
    return { eligible: false, reason: 'attempts_spent', attempts, escalation: 0 }
  }
  return { eligible: true, reason: attempts === 0 ? 'first_attempt' : 'retry', attempts, escalation: attempts + 1 }
}

/**
 * PURE: fold one attempt's outcome into the profile's ledger entry.
 *
 * BURN SEMANTICS (identical to `enforceAmountEnrichment` / `enforceApplicationUrlRescue`):
 *   - `TRANSIENT` — the pass could not run. Attempts are NOT spent and nothing
 *     is recorded but the timestamp. A crawler outage must never cost a profile
 *     its chance.
 *   - `ADDED` — real awardable results arrived. Attempts RESET to 0: progress
 *     means the lane is productive and deserves a full budget again.
 *   - `NO_NEW_RESULTS` — the pass searched and found nothing. Attempts +1; at
 *     `maxAttempts` the honest verdict is recorded with its evidence.
 *
 * The caller must only call this AFTER the recount has succeeded — a mark
 * written before the outcome is known is the #946 defect.
 *
 * @param {object|null} entry
 * @param {object} outcome  { outcome, target, awardable, added, evidence, at }
 */
export function applyFloorAttempt(entry, {
  outcome,
  target,
  awardable,
  added = 0,
  evidence = null,
  at = new Date().toISOString(),
  maxAttempts = RESULT_FLOOR_MAX_ATTEMPTS,
  fingerprint = null,
} = {}) {
  const prev = entry && typeof entry === 'object' ? { ...entry } : {}
  const next = {
    ...prev,
    target: Number(target) || 0,
    awardable: Number(awardable) || 0,
    best_awardable: Math.max(Number(prev.best_awardable) || 0, Number(awardable) || 0),
    last_attempt_at: at,
    last_outcome: outcome,
    last_attempt_added: Number(added) || 0,
    ...(fingerprint ? { fingerprint } : {}),
  }

  if (outcome === FLOOR_OUTCOME.TRANSIENT) {
    // Nothing is spent and nothing is concluded.
    next.attempts = Number(prev.attempts) || 0
    return next
  }

  if (Number(awardable) >= Number(target)) {
    // The floor is MET. Clear the whole attempt state — this profile is served.
    next.attempts = 0
    next.exhausted_at = null
    next.exhausted_evidence = null
    next.last_outcome = FLOOR_OUTCOME.ADDED
    return next
  }

  if (outcome === FLOOR_OUTCOME.ADDED && Number(added) > 0) {
    // Progress, but still short: the lane is productive, so give it a full
    // budget again rather than counting down to a premature "exhausted".
    next.attempts = 0
    next.exhausted_at = null
    next.exhausted_evidence = null
    return next
  }

  const attempts = (Number(prev.attempts) || 0) + 1
  next.attempts = attempts
  if (attempts >= maxAttempts) {
    next.exhausted_at = at
    // The verdict must name what was actually done, or it is just a shrug.
    next.exhausted_evidence = {
      target: Number(target) || 0,
      found: Number(awardable) || 0,
      attempts,
      lanes_queried: Number(evidence?.lanes_queried) || 0,
      queries_issued: Number(evidence?.queries_issued) || 0,
      pages_fetched: Number(evidence?.pages_fetched) || 0,
      candidates_extracted: Number(evidence?.candidates_extracted) || 0,
      rejected_by_engine: Number(evidence?.rejected_by_engine) || 0,
      added_total: Number(evidence?.added_total) || 0,
    }
    next.last_outcome = FLOOR_OUTCOME.EXHAUSTED
  }
  return next
}

/**
 * PURE: the human sentence an exhausted verdict is allowed to make. Every
 * number in it comes from a measurement — there is no "we tried hard" here.
 */
export function describeExhaustion(entry) {
  const e = entry?.exhausted_evidence
  if (!entry?.exhausted_at || !e) return null
  return (
    `exhausted — searched ${e.lanes_queried} lane(s) and ${e.queries_issued} quer${e.queries_issued === 1 ? 'y' : 'ies'} ` +
    `over ${e.attempts} attempt(s); ${e.candidates_extracted} candidate(s) reached the engine, ` +
    `${e.rejected_by_engine} were rejected, ${e.added_total} were added. ` +
    `Found ${e.found} of a requested ${e.target}.`
  )
}

/**
 * PURE: order the backfill queue.
 *
 * FEWEST ATTEMPTS FIRST, then deepest shortfall. The attempts-first key is not
 * cosmetic: `enforceAmountEnrichment` shipped with the opposite order and
 * retries starved never-tried rows out of the budget for a week. Deepest
 * shortfall breaks the tie so a profile with nothing is served before one that
 * is one short.
 */
export function orderFloorQueue(candidates = []) {
  return [...candidates].sort((a, b) => {
    const at = (Number(a.attempts) || 0) - (Number(b.attempts) || 0)
    if (at !== 0) return at
    const sh = (Number(b.shortfall) || 0) - (Number(a.shortfall) || 0)
    if (sh !== 0) return sh
    return String(a.profile_id ?? '').localeCompare(String(b.profile_id ?? ''))
  })
}

export default {
  DEFAULT_PROFILE_RESULT_TARGET,
  MIN_PROFILE_RESULT_TARGET,
  MAX_PROFILE_RESULT_TARGET,
  RESULT_FLOOR_KV_KEY,
  RESULT_FLOOR_MAX_ATTEMPTS,
  RESULT_FLOOR_COOLDOWN_DAYS,
  RESULT_FLOOR_CATALOG_DRIFT_STEP,
  FLOOR_OUTCOME,
  resolveFleetResultTarget,
  resolveProfileResultTarget,
  buildFloorFingerprint,
  evaluateFloorEligibility,
  applyFloorAttempt,
  describeExhaustion,
  orderFloorQueue,
}
