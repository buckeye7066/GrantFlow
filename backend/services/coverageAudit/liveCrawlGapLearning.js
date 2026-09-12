/**
 * liveCrawlGapLearning.js — make Anya and Sam learn from crawler gaps GLOBALLY,
 * on EVERY live discovery call, not just Amy's synthetic cohort or the nightly
 * coverage sweep.
 *
 * The Amy→Anya→Sam loop already knows how to turn a discovery outcome into
 * structured "gaps" (institution / hyperlocal / low-results / ineligible /
 * surfacing-regression) via `auditProfileResultCoverage`. Until now that audit
 * only ran for synthetic Amy profiles or in the offline nightly sweep, so real
 * production crawls taught the agents nothing in real time.
 *
 * This module hangs a single best-effort hook off the ONE global discovery
 * choke-point (`runProfileDiscoveryLive` in crawlerOsService.js). After every
 * live crawl it:
 *
 *   1. reuses `auditProfileResultCoverage` (NO detection drift) to find gaps,
 *   2. ATTRIBUTES the gap to ONE primary cause read off the run's own web-lane
 *      ledger (`attributePrimaryGap`): a dead LLM, a dead search backend, a
 *      query budget that never executed the plan, a gate that rejected every
 *      candidate, a healthy empty web, … — never one collapsed "low_results",
 *   3. folds the outcome into a rolling, observable learning store in
 *      `system_kv` (key `crawler_gap_learning`) that Sam's diagnostics read —
 *      per UTC day: calls, with_gap, by_class, by_attribution, by_trigger,
 *      distinct profiles,
 *   4. writes the pattern into Anya's brain (`anya_brain_memory`) so Anya learns
 *      per-profile, and
 *   5. records low-coverage telemetry (reusing the existing table) for trending.
 *
 * Everything is best-effort and wrapped so it can NEVER block or fail a crawl —
 * learning is observability, not a critical path.
 *
 * Detection lives in profileResultCoverageAudit.js; the pure store-fold below
 * (`buildGapLearningUpdate`) and the pure attribution (`attributePrimaryGap`)
 * are separated from I/O so they unit-test with plain fixtures.
 *
 * WHY THE 7-DAY NUMBER LOOKED THE WAY IT DID (2026-09-12): prod's window read
 * 1,722 of 1,774 live crawls with a gap, `result_floor_shortfall` ×1,696 AND
 * `low_results` ×1,696. Those were the SAME 1,696 events — `classifyGaps`
 * echoed the floor class as `low_results` for the query builder — and almost
 * all of them were crawls whose extractor was dead (every LLM route out of
 * credit 09-03..09-12), which the audit could not see because it only ever
 * read persisted admission state. Both are fixed here: the store counts the
 * audit's OWN classes, and every record carries its primary attribution.
 */

import { DEFAULT_MIN_SCORE } from '../../config/matchThresholds.js'
import { auditProfileResultCoverage } from './profileResultCoverageAudit.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:liveGapLearning')

/** system_kv key holding the rolling live-crawl gap learning store. */
export const KV_KEY = 'crawler_gap_learning'

/** How many recent gap events to retain in the rolling store. */
export const RECENT_CAP = 50

/** How many daily buckets to retain (drives the windowed gap rate). */
export const WINDOW_RETENTION_DAYS = 14

/** Default window (days) Sam judges the gap rate over. */
export const WINDOW_DAYS = 7

/** Per-day cap on the distinct profile-id list kept for population accounting. */
export const DISTINCT_PROFILE_CAP = 400

/** TTL for the per-profile pattern written into Anya's brain. */
const MEMORY_TTL_DAYS = 30

/** The gap classes we learn from, in priority order (worst first). */
export const GAP_CLASSES = Object.freeze([
  'surfacing_regression',
  'ineligible_surfaced_match',
  'institution_gap',
  'hyperlocal_gap',
  'result_floor_shortfall',
  'low_results',
])

/**
 * The primary-attribution vocabulary. `extraction_failed` and `gate_rejected`
 * always carry a suffix in a concrete record (`extraction_failed:llm_quota`,
 * `gate_rejected:need`); the bare names here are the families.
 */
export const PRIMARY_ATTRIBUTIONS = Object.freeze([
  'healthy_no_results',
  'query_budget_truncation',
  'provider_unavailable',
  'provider_degraded',
  'extraction_failed',
  'canonical_duplicate',
  'gate_rejected',
  'under_result_target',
  'no_crawl',
  'unknown',
])

/** The trigger populations a live crawl can come from (livegap-4). */
export const CRAWL_TRIGGERS = Object.freeze([
  'auth', 'fleet', 'dispatcher', 'admin', 'heal', 'backfill', 'anya', 'script', 'unattributed',
])

/** Global on/off (default ON). Set CRAWLER_GAP_LEARNING_ENABLED=false to disable. */
export function isCrawlerGapLearningEnabled() {
  return String(process.env.CRAWLER_GAP_LEARNING_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/**
 * Map a coverage audit → the flat list of gap-class keys present in it.
 *
 * These are the audit's OWN booleans and nothing else (webq-10 / livegap-3).
 * `result_floor_shortfall` (awardable < the profile's requested number,
 * default 20) and `low_results` (actionable < MIN_HEALTHY_SURFACED = 3, the
 * "this profile is BROKEN" alarm) are DIFFERENT conditions and are counted
 * separately. The query builder consumes `result_floor_shortfall` directly
 * (webQueries.hasPersistentQueryShortfall accepts both), so the old
 * `low_results` alias is no longer needed to steer the next crawl.
 */
export function classifyGaps(audit) {
  if (!audit || typeof audit !== 'object') return []
  const out = []
  if (audit.surfacing_gap) out.push('surfacing_regression')
  if (audit.ineligible_surfaced_match) out.push('ineligible_surfaced_match')
  if (audit.institution_gap) out.push('institution_gap')
  if (audit.hyperlocal_gap) out.push('hyperlocal_gap')
  if (audit.below_result_target) out.push('result_floor_shortfall')
  if (audit.low_results) out.push('low_results')
  return out
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function stageOf(ledger) {
  const s = ledger?.stage_ledger
  return s && typeof s === 'object' ? s : null
}

function dominantKey(obj) {
  let best = null
  let bestN = 0
  for (const [k, v] of Object.entries(obj || {})) {
    if (num(v) > bestN) { best = k; bestN = num(v) }
  }
  return best
}

/**
 * PURE: attribute a crawl's coverage gap to ONE primary cause, read off the
 * run's own web-lane ledger (`run.web_lane` from runWebDiscoveryLane) and,
 * when supplied, the profile's coverage audit.
 *
 * Precedence (first match wins) — a fact about the crawl's own machinery
 * always outranks a claim about the world:
 *   1. no ledger at all                                          → 'unknown'
 *   2. lane skipped / deps missing / nothing ever searched        → 'no_crawl'
 *   3. every executed query unavailable                           → 'provider_unavailable'
 *   4. pages fetched, zero candidates, classified failures        → 'extraction_failed:<dominant class>'
 *   5. candidates extracted, none admitted:
 *        dominant of reality/eligibility/need/apply_target/dup    → 'gate_rejected:<gate>' | 'canonical_duplicate'
 *   6. some queries degraded/unavailable, nothing admitted        → 'provider_degraded'
 *   7. planned queries the page budget never executed, none admitted → 'query_budget_truncation'
 *   8. healthy pipeline, nothing admitted                         → 'healthy_no_results'
 *   9. healthy pipeline, rows admitted, audit still shows a gap    → 'under_result_target'
 *  10. healthy pipeline, rows admitted, no gap (or no audit)       → null (nothing to attribute)
 *
 * @param {{ ledger?:object|null, audit?:object|null }} args
 * @returns {string|null}
 */
export function attributePrimaryGap({ ledger = null, audit = null } = {}) {
  if (!ledger || typeof ledger !== 'object') return 'unknown'
  if (ledger.skipped === true) return 'no_crawl'
  const stage = stageOf(ledger)
  const attemptedQueries = stage ? num(stage.provider_attempted)
    : (Array.isArray(ledger.search_provenance) ? ledger.search_provenance.length : (Array.isArray(ledger.queries) ? ledger.queries.length : num(ledger.queries)))
  if (ledger.ok === false && attemptedQueries === 0) return 'no_crawl'
  if (attemptedQueries === 0) return 'no_crawl'

  const unavailable = stage ? num(stage.provider_unavailable) : num(ledger.search_unavailable_queries)
  const degraded = stage ? num(stage.provider_degraded) : num(ledger.search_degraded_queries)
  if (unavailable > 0 && unavailable >= attemptedQueries) return 'provider_unavailable'

  const fetched = num(ledger.fetched)
  const candidates = stage ? num(stage.candidates_extracted) : num(ledger.extracted)
  const failed = stage ? num(stage.extraction_failed) : 0
  const failedByClass = stage?.extraction_failed_by_class || {}
  if (fetched > 0 && candidates === 0 && failed > 0) {
    return `extraction_failed:${dominantKey(failedByClass) || 'unknown'}`
  }

  const admitted = stage ? num(stage.qualified_admitted) : num(ledger.stored)
  if (candidates > 0 && admitted === 0) {
    const buckets = [
      ['gate_rejected:reality', num(stage?.reality_rejected)],
      ['gate_rejected:eligibility', num(stage?.eligibility_rejected)],
      ['gate_rejected:need', num(stage?.need_match_rejected)],
      ['gate_rejected:apply_target', num(stage?.apply_target_rejected)],
      ['canonical_duplicate', num(stage?.canonical_duplicates)],
    ].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    if (buckets.length) return buckets[0][0]
  }

  if (admitted === 0 && (degraded > 0 || unavailable > 0)) return 'provider_degraded'

  const skippedBudget = stage ? num(stage.query_skipped_budget) : num(ledger.query_ledger?.skipped_budget?.length)
  if (admitted === 0 && skippedBudget > 0) return 'query_budget_truncation'
  if (admitted === 0) return 'healthy_no_results'

  // Rows were admitted through a healthy pipeline. Only the audit can say
  // whether the profile is still short.
  if (audit && typeof audit === 'object') {
    if (audit.below_result_target || audit.has_gap || audit.low_results || audit.institution_gap || audit.hyperlocal_gap) return 'under_result_target'
    return null
  }
  return null
}

/** Compact lane summary carried on recent records and brain memory. */
export function summarizeLaneLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') return null
  const stage = stageOf(ledger)
  return {
    ok: ledger.ok !== false,
    skipped: ledger.skipped === true,
    reason: ledger.reason ?? null,
    queries_planned: Array.isArray(ledger.queries_planned) ? ledger.queries_planned.length : (num(ledger.queries_planned) || (Array.isArray(ledger.queries) ? ledger.queries.length : num(ledger.queries))),
    queries_executed: Array.isArray(ledger.queries) ? ledger.queries.length : num(ledger.queries_executed ?? ledger.queries),
    queries_skipped_budget: num(stage?.query_skipped_budget),
    pages: num(ledger.pages),
    fetched: num(ledger.fetched),
    extracted: num(ledger.extracted),
    extraction_failed: num(stage?.extraction_failed),
    extraction_failed_by_class: { ...(stage?.extraction_failed_by_class || {}) },
    reality_rejected: num(stage?.reality_rejected),
    eligibility_rejected: num(stage?.eligibility_rejected),
    need_match_rejected: num(stage?.need_match_rejected),
    apply_target_rejected: num(stage?.apply_target_rejected),
    canonical_duplicates: num(stage?.canonical_duplicates),
    admitted: num(stage?.qualified_admitted),
    stored: num(ledger.stored),
    provider_health: {
      search: ledger.provider_health?.search ?? 'unknown',
      llm: ledger.provider_health?.llm ?? 'unknown',
    },
  }
}

function bump(map, key, by = 1) {
  if (!key) return
  map[key] = num(map[key]) + by
}

/**
 * PURE: fold one profile's coverage audit into the rolling learning store.
 * Always counts the call; only records a `recent` entry (and per-class tallies)
 * when the crawl actually surfaced a gap. No I/O — unit-testable with fixtures.
 *
 * @param {object|null} prev   previous store value (from getCrawlerGapLearning)
 * @param {object} audit       an auditProfileResultCoverage(FromData) result
 * @param {object} meta        { profileId, displayName, at, attribution, trigger, lane }
 * @returns {{ totals:object, days:object, recent:Array, updated_at:string }}
 */
export function buildGapLearningUpdate(prev, audit, { profileId, displayName = null, at, attribution = null, trigger = null, lane = null } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const prevTotals = base.totals && typeof base.totals === 'object' ? base.totals : {}
  const totals = {
    calls: num(prevTotals.calls),
    with_gap: num(prevTotals.with_gap),
    by_class: { ...(prevTotals.by_class || {}) },
    by_attribution: { ...(prevTotals.by_attribution || {}) },
    by_trigger: { ...(prevTotals.by_trigger || {}) },
  }
  const trig = trigger ? String(trigger) : 'unattributed'

  totals.calls += 1
  bump(totals.by_trigger, trig)
  const classes = classifyGaps(audit)
  if (classes.length > 0) {
    totals.with_gap += 1
    for (const c of classes) bump(totals.by_class, c)
    if (attribution) bump(totals.by_attribution, attribution)
  }

  // Daily buckets — the windowed view. Lifetime `totals` never decay, so a
  // long-lived store reads as a permanent alert once it has ever been gappy;
  // Sam's rate must be judged over a recent window instead. Keyed by UTC day,
  // pruned to WINDOW_RETENTION_DAYS. Only real ISO dates bucket (fixture
  // timestamps like 't1' are counted in totals but not windowed).
  const days = { ...(base.days && typeof base.days === 'object' ? base.days : {}) }
  const dayKey = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null
  if (dayKey) {
    const bucket = days[dayKey] && typeof days[dayKey] === 'object' ? { ...days[dayKey] } : {}
    bucket.calls = num(bucket.calls) + 1
    bucket.with_gap = num(bucket.with_gap)
    bucket.by_class = { ...(bucket.by_class || {}) }
    bucket.by_attribution = { ...(bucket.by_attribution || {}) }
    bucket.by_trigger = { ...(bucket.by_trigger || {}) }
    bucket.with_gap_by_trigger = { ...(bucket.with_gap_by_trigger || {}) }
    bump(bucket.by_trigger, trig)
    if (classes.length > 0) {
      bucket.with_gap += 1
      for (const c of classes) bump(bucket.by_class, c)
      if (attribution) bump(bucket.by_attribution, attribution)
      bump(bucket.with_gap_by_trigger, trig)
    }
    // Distinct profiles per day (livegap-4): the rate is per CALL, and the
    // heal loop re-crawls the SAME below-target profiles nightly, so the
    // population must be visible beside the call count.
    const ids = Array.isArray(bucket.profile_ids) ? bucket.profile_ids.slice() : []
    const pid = profileId === null || profileId === undefined ? null : String(profileId)
    if (pid && !ids.includes(pid)) {
      if (ids.length < DISTINCT_PROFILE_CAP) ids.push(pid)
      else bucket.profile_ids_truncated = true
    }
    bucket.profile_ids = ids
    bucket.distinct_profiles = ids.length
    days[dayKey] = bucket
    const keys = Object.keys(days).sort()
    while (keys.length > WINDOW_RETENTION_DAYS) delete days[keys.shift()]
  }

  let recent = Array.isArray(base.recent) ? base.recent.slice() : []
  if (classes.length > 0) {
    recent.unshift({
      profile_id: profileId ?? null,
      display_name: displayName ?? null,
      classes,
      gaps: Array.isArray(audit?.gaps) ? audit.gaps : [],
      surfaced_qualifying: audit?.surfaced_qualifying ?? null,
      surfaced_awardable: audit?.surfaced_awardable ?? null,
      result_target: audit?.result_target ?? null,
      needs_rediscovery: Boolean(audit?.needs_rediscovery),
      primary_attribution: attribution ?? null,
      trigger: trig,
      lane: lane ?? null,
      at: at ?? null,
    })
    recent = recent.slice(0, RECENT_CAP)
  }

  return { totals, days, recent, updated_at: at ?? base.updated_at ?? null }
}

/**
 * PURE: record a call whose audit FAILED (the crawl ran, the coverage could not
 * be judged). Counted as `unevaluated` on the day bucket so the window's
 * population is honest; never counted as a call with or without a gap.
 */
export function buildGapLearningUnevaluated(prev, { at, trigger = null } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const totals = { ...(base.totals || {}), unevaluated: num(base.totals?.unevaluated) + 1 }
  const days = { ...(base.days && typeof base.days === 'object' ? base.days : {}) }
  const dayKey = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null
  if (dayKey) {
    const bucket = days[dayKey] && typeof days[dayKey] === 'object' ? { ...days[dayKey] } : { calls: 0, with_gap: 0, by_class: {} }
    bucket.unevaluated = num(bucket.unevaluated) + 1
    bucket.unevaluated_by_trigger = { ...(bucket.unevaluated_by_trigger || {}) }
    bump(bucket.unevaluated_by_trigger, trigger ? String(trigger) : 'unattributed')
    days[dayKey] = bucket
  }
  return { ...base, totals, days, updated_at: at ?? base.updated_at ?? null }
}

/**
 * PURE: the windowed view Sam's gap-rate check judges. Sums the daily buckets
 * within the last `days` UTC days (inclusive of today). Returns null when the
 * store has no daily buckets yet (a pre-window store) so callers can fall back
 * to the lifetime totals rather than mistaking "no window data" for "healthy".
 * A store WITH buckets but none inside the window returns `calls: 0` — the
 * caller must report that as "no live crawls in the window", never as lifetime.
 *
 * @param {object|null} store  value from getCrawlerGapLearning
 * @param {{ days?:number, nowMs?:number }} [opts]
 * @returns {{ days:number, window_start:string, window_end:string, calls:number, with_gap:number,
 *   by_class:object, by_attribution:object, by_trigger:object, with_gap_by_trigger:object,
 *   distinct_profiles:number, distinct_profiles_lower_bound:boolean, unevaluated:number,
 *   days_with_calls:number, rate:number }|null}
 */
export function summarizeGapWindow(store, { days = WINDOW_DAYS, nowMs = Date.now() } = {}) {
  const buckets = store?.days && typeof store.days === 'object' ? store.days : null
  if (!buckets) return null
  const end = new Date(nowMs).toISOString().slice(0, 10)
  const cutoff = new Date(nowMs - (days - 1) * 86400000).toISOString().slice(0, 10)
  const out = {
    days,
    window_start: cutoff,
    window_end: end,
    calls: 0,
    with_gap: 0,
    by_class: {},
    by_attribution: {},
    by_trigger: {},
    with_gap_by_trigger: {},
    distinct_profiles: 0,
    distinct_profiles_lower_bound: false,
    unevaluated: 0,
    days_with_calls: 0,
    rate: 0,
  }
  const ids = new Set()
  let sawBucket = false
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    sawBucket = true
    if (key < cutoff || key > end) continue
    const calls = num(bucket?.calls)
    out.calls += calls
    if (calls > 0) out.days_with_calls += 1
    out.with_gap += num(bucket?.with_gap)
    out.unevaluated += num(bucket?.unevaluated)
    for (const [c, n] of Object.entries(bucket?.by_class || {})) bump(out.by_class, c, num(n))
    for (const [c, n] of Object.entries(bucket?.by_attribution || {})) bump(out.by_attribution, c, num(n))
    for (const [c, n] of Object.entries(bucket?.by_trigger || {})) bump(out.by_trigger, c, num(n))
    for (const [c, n] of Object.entries(bucket?.with_gap_by_trigger || {})) bump(out.with_gap_by_trigger, c, num(n))
    for (const id of Array.isArray(bucket?.profile_ids) ? bucket.profile_ids : []) ids.add(String(id))
    if (bucket?.profile_ids_truncated) out.distinct_profiles_lower_bound = true
    if (!Array.isArray(bucket?.profile_ids) && calls > 0) out.distinct_profiles_lower_bound = true
  }
  if (!sawBucket) return null
  out.distinct_profiles = ids.size
  out.rate = out.calls > 0 ? out.with_gap / out.calls : 0
  return out
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the rolling learning store (for Sam diagnostics / Anya owner tools). */
export async function getCrawlerGapLearning(db) {
  if (!db?.prepare) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { ...parsed, updated_at: row.updated_at ?? parsed.updated_at ?? null }
  } catch {
    return null
  }
}

async function writeStore(db, store) {
  await ensureKv(db)
  const now = store.updated_at || new Date().toISOString()
  const value = JSON.stringify(store)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
  }
}

/**
 * The global hook. Audits the just-crawled profile's RESULT coverage, attributes
 * the outcome to ONE primary cause from the run's lane ledger, and records it
 * into the shared learning store (Sam) + Anya's brain (Anya) + low-coverage
 * telemetry. Best-effort: catches everything and never throws.
 *
 * @param {object} db
 * @param {object} args { profileId, thesis?, displayName?, laneLedger?, trigger? }
 *   laneLedger = run.web_lane from the same crawl; trigger = which population
 *   produced the call (auth / fleet / dispatcher / admin / heal / backfill / …).
 * @returns {Promise<object>} { ok, has_gap, classes, gaps, primary_attribution } (for logs/tests/the choke point)
 */
export async function learnFromCrawlGaps(db, { profileId, thesis = null, displayName = null, laneLedger = null, trigger = null } = {}) {
  if (!isCrawlerGapLearningEnabled()) return { skipped: true, reason: 'disabled' }
  if (!db?.prepare || !profileId) return { skipped: true, reason: 'no_db_or_profile' }

  const at = new Date().toISOString()
  const lane = summarizeLaneLedger(laneLedger)
  let audit
  try {
    // 1. Detect gaps using the EXISTING audit (no detection drift). Passing the
    //    already-built thesis avoids a rebuild; the audit falls back to loading
    //    it when absent.
    audit = await auditProfileResultCoverage(db, profileId, thesis ? { thesis } : {})
  } catch (err) {
    // The crawl ran but coverage could not be judged: count it as UNEVALUATED
    // (never silently dropped from the population) and hand back the lane-only
    // attribution so the lane record still names its own failure.
    log.warn('learnFromCrawlGaps audit failed (non-fatal, counted unevaluated)', { profile: profileId, error: err?.message })
    try {
      const prev = await getCrawlerGapLearning(db)
      await writeStore(db, buildGapLearningUnevaluated(prev, { at, trigger }))
    } catch { /* best-effort */ }
    return { ok: false, error: err?.message, primary_attribution: attributePrimaryGap({ ledger: laneLedger, audit: null }) }
  }

  try {
    // 2. Attribute, then fold into the rolling, observable learning store.
    const primaryAttribution = attributePrimaryGap({ ledger: laneLedger, audit })
    const prev = await getCrawlerGapLearning(db)
    const next = buildGapLearningUpdate(prev, audit, { profileId, displayName, at, attribution: primaryAttribution, trigger, lane })
    await writeStore(db, next)

    if (!audit.has_gap) return { ok: true, has_gap: false, primary_attribution: primaryAttribution }

    const classes = classifyGaps(audit)

    // 3. Anya learns — persist the per-profile pattern into her brain.
    try {
      const { storeMemory } = await import('../anyaBrainService.js')
      const expiresAt = new Date(Date.now() + MEMORY_TTL_DAYS * 86400000).toISOString()
      await storeMemory(db, {
        scope: 'profile',
        scopeId: String(profileId),
        memoryType: 'learned_pattern',
        memoryKey: 'crawler_gap',
        content: {
          gaps: audit.gaps,
          classes,
          needs_rediscovery: Boolean(audit.needs_rediscovery),
          surfaced_qualifying: audit.surfaced_qualifying ?? null,
          missing_schools: audit.missing_schools || [],
          primary_attribution: primaryAttribution,
          trigger: trigger ?? null,
          lane,
          observed_at: at,
        },
        confidence: 0.9,
        source: 'crawler_gap_learning',
        expiresAt,
      })
    } catch (err) {
      log.warn('anya brain write failed (non-fatal)', { profile: profileId, error: err?.message })
    }

    // 4. Sam telemetry — reuse the existing low-coverage table for the low_results
    //    class so trending stays in one place.
    if (audit.low_results) {
      try {
        const { recordLowCoverageEvent } = await import('../matching/professionalDevelopmentPolicy.js')
        await recordLowCoverageEvent(db, {
          profileId,
          qualifiedCount: audit.surfaced_qualifying ?? 0,
          minScore: DEFAULT_MIN_SCORE,
        })
      } catch {
        /* best-effort telemetry */
      }
    }

    return { ok: true, has_gap: true, classes, gaps: audit.gaps, primary_attribution: primaryAttribution }
  } catch (err) {
    log.warn('learnFromCrawlGaps failed (non-fatal)', { profile: profileId, error: err?.message })
    return { ok: false, error: err?.message, primary_attribution: attributePrimaryGap({ ledger: laneLedger, audit: null }) }
  }
}

export default {
  KV_KEY,
  RECENT_CAP,
  WINDOW_RETENTION_DAYS,
  WINDOW_DAYS,
  DISTINCT_PROFILE_CAP,
  GAP_CLASSES,
  PRIMARY_ATTRIBUTIONS,
  CRAWL_TRIGGERS,
  isCrawlerGapLearningEnabled,
  classifyGaps,
  attributePrimaryGap,
  summarizeLaneLedger,
  buildGapLearningUpdate,
  buildGapLearningUnevaluated,
  summarizeGapWindow,
  getCrawlerGapLearning,
  learnFromCrawlGaps,
}
