/**
 * webLaneHealth.js — observability for the open-web discovery lane.
 *
 * The web lane (webLane.js: profile-keyed search → LLM extraction → reality
 * gate) is the ONLY path to county/community/foundation funding — the exact
 * coverage the hyperlocal/institution gap classes measure. It is deliberately
 * best-effort: a dead search backend (Brave 402, SearXNG upstream engines
 * suspended, DDG throttling) or an exhausted LLM key degrades it to a silent
 * no-op. That silence is the defect this module fixes: in July 2026 the lane
 * was dead for 3+ days and the only symptom was every live crawl logging a
 * hyperlocal gap — the CONSEQUENCE, not the cause. In September 2026 it
 * happened again one layer down: every LLM route was dead for nine days, the
 * lane fetched ~40 pages per crawl and extracted ZERO, and this store recorded
 * `ok:true queries:28 extracted:0 reason:null` — the PLANNED query count, no
 * provider verdict, no failure class — so ~1,700 crawls were filed as recall
 * gaps instead of as an extraction outage.
 *
 * After every live discovery, runProfileDiscoveryLive records the lane's
 * telemetry here in TWO shapes:
 *   - system_kv `web_lane_health`: a rolling ring of the last RECENT_CAP runs,
 *     each a BOUNDED summary (executed vs planned queries, provider counts,
 *     stage counters, provider_health, primary_attribution) — never the
 *     per-page ledger;
 *   - system_kv `web_lane_last_runs`: ONE row holding every profile's FULL
 *     last-run record (query ledger, stage ledger, page ledger ≤ max_pages,
 *     seed outcomes), keyed by profile id and LRU-capped at
 *     LAST_RUN_MAX_PROFILES entries (evicting the oldest `at`). The web-parity
 *     benchmark reads a single profile's slice via `getLastWebLaneRun`.
 *     Before this bounded store, each profile got its OWN permanent
 *     `web_lane_last_run:<profileId>` row that outlived the profile —
 *     including Amy's nightly-reaped synthetic cohort, which mints a fresh
 *     `randomUUID()` profile per run — so system_kv grew one row per profile
 *     ever crawled, forever, with no TTL and no cleanup path (system_kv has no
 *     `profile_id` column, so the profile-deletion sweep can never reach it).
 *     A one-time lazy migration purges those legacy rows the first time this
 *     module touches system_kv after upgrade; see purgeLegacyLastRunRowsOnce.
 *
 * Sam's `crawler.webLaneHealth` check reads the ring and reds out when the
 * judged runs are DEAD (queries ran, zero pages — the search layer) or
 * EXTRACTION_DEAD (pages fetched, nothing extracted, classified LLM failures —
 * the extraction layer). Skipped / no-crawl runs are reported, never judged.
 *
 * Pure fold + summary are separated from I/O so they unit-test with fixtures,
 * mirroring liveCrawlGapLearning.js.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:webLaneHealth')

/** system_kv key holding the rolling web-lane health store. */
export const KV_KEY = 'web_lane_health'

/** system_kv key holding every profile's last-run record (LRU-capped). */
export const LAST_RUN_KV_KEY = 'web_lane_last_runs'

/** Hard cap on distinct profiles retained in the last-run store, evicting the
 *  entry with the oldest `at` first — the bound that replaces one permanent
 *  system_kv row per profile ever crawled. */
export const LAST_RUN_MAX_PROFILES = 200

/** Legacy (pre-bounded-store) per-profile key prefix — one system_kv row per
 *  profile that ever ran live discovery, never cleaned up even after the
 *  profile (including Amy's nightly-reaped synthetics) was deleted. No longer
 *  written; purged lazily on upgrade by purgeLegacyLastRunRowsOnce. */
export const LEGACY_LAST_RUN_KV_PREFIX = 'web_lane_last_run:'

/** system_kv flag key marking the legacy purge as already done (idempotent). */
const LEGACY_LAST_RUN_PURGED_FLAG_KEY = 'web_lane_last_run_legacy_purged'

/** How many recent lane runs to retain. */
export const RECENT_CAP = 30

/** How many recent JUDGEABLE runs the Sam check judges (must all be dead to alert). */
export const JUDGE_LAST_N = 8

/** Minimum judgeable runs before the Sam check may alert (avoid cold-start noise). */
export const MIN_RUNS_TO_JUDGE = 5

/** Hard bound on the per-profile page ledger when the lane did not state max_pages. */
const DEFAULT_PAGE_LEDGER_CAP = 64

/** Extraction failure classes that mean the EXTRACTOR (LLM path) failed, not the page. */
const LLM_FAILURE_CLASSES = new Set(['llm_unavailable', 'llm_quota', 'llm_timeout', 'parse_error', 'unknown'])

function profileKey(profileId) {
  return String(profileId ?? '').trim()
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function smallMap(obj, cap = 24) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj).slice(0, cap)) out[String(k).slice(0, 64)] = num(v)
  return out
}

function providerHealthOf(telemetry) {
  const ph = telemetry?.provider_health
  return {
    search: typeof ph?.search === 'string' ? ph.search : 'unknown',
    llm: typeof ph?.llm === 'string' ? ph.llm : 'unknown',
  }
}

function stageLedgerOf(telemetry) {
  const s = telemetry?.stage_ledger
  if (!s || typeof s !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'extraction_failed_by_class') out[k] = smallMap(v)
    else out[k] = num(v)
  }
  return out
}

/**
 * PURE: the FULL bounded record of one lane run (persisted per profile in the
 * `web_lane_last_runs` bounded store). Every field is plain JSON.
 *
 * @param {object} telemetry  run.web_lane from runProfileDiscoveryLive
 * @param {{ profileId?:string|null, at?:string|null, trigger?:string|null }} meta
 */
export function buildWebLaneRunRecord(telemetry, { profileId = null, at = null, trigger = null } = {}) {
  const t = telemetry && typeof telemetry === 'object' ? telemetry : {}
  const skipped = t.skipped === true
  const executedQueries = Array.isArray(t.queries) ? t.queries.filter((q) => typeof q === 'string') : []
  const plannedQueries = Array.isArray(t.queries_planned) ? t.queries_planned.filter((q) => typeof q === 'string') : null
  const queryLedger = t.query_ledger && typeof t.query_ledger === 'object' ? t.query_ledger : null
  const maxPages = numOrNull(t.max_pages)
  const pageCap = maxPages && maxPages > 0 ? maxPages : DEFAULT_PAGE_LEDGER_CAP
  const rawPages = Array.isArray(t.page_ledger) ? t.page_ledger : (Array.isArray(t.pages_ledger) ? t.pages_ledger : [])
  const pages = rawPages.slice(0, pageCap).map((p) => ({
    url: p?.url ?? null,
    canonical_key: p?.canonical_key ?? null,
    query: p?.query ?? null,
    seeded: p?.seeded === true,
    fetched: p?.fetched === true,
    fetch_status: p?.fetch_status ?? null,
    final_url: p?.final_url ?? null,
    extracted: num(p?.extracted),
    extraction_failure: p?.extraction_failure ?? null,
    reality_rejected: num(p?.reality_rejected),
    reality_reason: p?.reality_reason ?? null,
    gate_rejected: {
      eligibility: num(p?.gate_rejected?.eligibility),
      need: num(p?.gate_rejected?.need),
      apply_target: num(p?.gate_rejected?.apply_target),
    },
    canonical_duplicate: num(p?.canonical_duplicate),
    admitted: num(p?.admitted),
    stored: num(p?.stored),
    deduped: num(p?.deduped),
  }))
  const stage = stageLedgerOf(t)
  const ph = providerHealthOf(t)
  return {
    record_version: 1,
    at: at ?? null,
    profile_id: profileId ?? null,
    trigger: trigger ?? null,
    ok: t.ok !== false,
    skipped,
    reason: t.reason ?? null,
    error: t.error ?? null,
    // Queries: EXECUTED list + planned count (webq-1).
    queries: executedQueries,
    queries_executed: num(t.queries_executed ?? executedQueries.length),
    queries_planned: plannedQueries ? plannedQueries.length : (Array.isArray(t.queries) ? executedQueries.length : num(t.queries)),
    query_ledger: queryLedger
      ? {
          planned: Array.isArray(queryLedger.planned) ? queryLedger.planned.slice(0, 200) : [],
          executed: Array.isArray(queryLedger.executed) ? queryLedger.executed.slice(0, 200) : [],
          skipped_budget: Array.isArray(queryLedger.skipped_budget) ? queryLedger.skipped_budget.slice(0, 200) : [],
          skipped_duplicate: Array.isArray(queryLedger.skipped_duplicate) ? queryLedger.skipped_duplicate.slice(0, 200) : [],
          plan_dropped: queryLedger.plan_dropped && typeof queryLedger.plan_dropped === 'object'
            ? {
                by_cap: Array.isArray(queryLedger.plan_dropped.by_cap) ? queryLedger.plan_dropped.by_cap.slice(0, 200) : [],
                duplicates: Array.isArray(queryLedger.plan_dropped.duplicates) ? queryLedger.plan_dropped.duplicates.slice(0, 200) : [],
              }
            : null,
        }
      : null,
    stage_ledger: stage,
    pages,
    pages_truncated: Math.max(0, rawPages.length - pages.length) + num(t.page_ledger_truncated),
    seed_outcomes: Array.isArray(t.seed_outcomes) ? t.seed_outcomes.slice(0, 64) : [],
    provider_health: { ...ph, detail: t.provider_health?.detail ?? null },
    primary_attribution: t.primary_attribution ?? null,
    extraction_available: t.extraction_available ?? null,
    // Totals (kept for every legacy reader).
    pages_total: num(t.pages),
    pages_deduped: num(t.pages_deduped),
    seeded: num(t.seeded),
    seeded_adopted: num(t.seeded_adopted),
    fetched: num(t.fetched),
    extracted: num(t.extracted),
    stored: num(t.stored),
    deduped: num(t.deduped),
    rejected: num(t.rejected),
    search_provenance: Array.isArray(t.search_provenance) ? t.search_provenance.slice(0, 64) : [],
    search_provider_counts: smallMap(t.search_provider_counts),
    search_cache_hits: num(t.search_cache_hits),
    search_unknown_provenance_count: num(t.search_unknown_provenance_count),
    search_degraded_queries: num(t.search_degraded_queries),
    search_unavailable_queries: num(t.search_unavailable_queries),
    results_per_query: numOrNull(t.results_per_query),
    max_pages: maxPages,
    max_queries: numOrNull(t.max_queries),
  }
}

/**
 * PURE: the BOUNDED ring entry for one lane run (no per-page ledger).
 * Accepts either raw lane telemetry or a record from buildWebLaneRunRecord.
 */
export function buildWebLaneRingEntry(telemetry, { profileId = null, at = null, trigger = null } = {}) {
  const t = telemetry && typeof telemetry === 'object' ? telemetry : {}
  const skipped = t.skipped === true
  const executed = Array.isArray(t.queries) ? t.queries.length : num(t.queries_executed ?? t.queries)
  const stage = stageLedgerOf(t)
  const ph = providerHealthOf(t)
  const plannedCount = numOrNull(t.queries_planned) !== null && !Array.isArray(t.queries_planned)
    ? num(t.queries_planned)
    : (Array.isArray(t.queries_planned) ? t.queries_planned.length : (t.query_ledger?.planned?.length ?? executed))
  return {
    at: at ?? t.at ?? null,
    profile_id: profileId ?? t.profile_id ?? null,
    trigger: trigger ?? t.trigger ?? null,
    ok: t.ok !== false,
    skipped,
    // `queries` = EXECUTED (webq-1). Legacy entries written before 2026-09-12
    // hold the PLANNED count here; `queries_planned` is absent on those.
    queries: executed,
    queries_planned: plannedCount,
    queries_skipped_budget: num(stage?.query_skipped_budget ?? t.query_ledger?.skipped_budget?.length),
    queries_skipped_duplicate: num(stage?.query_skipped_duplicate ?? t.query_ledger?.skipped_duplicate?.length),
    pages: num(t.pages_total ?? t.pages),
    pages_deduped: num(t.pages_deduped),
    seeded: num(t.seeded),
    fetched: num(t.fetched),
    extracted: num(t.extracted),
    stored: num(t.stored),
    deduped: num(t.deduped),
    rejected: num(t.rejected),
    extraction_failed: num(stage?.extraction_failed),
    extraction_failed_by_class: stage ? { ...stage.extraction_failed_by_class } : {},
    stage_ledger: stage,
    search_provider_counts: smallMap(t.search_provider_counts),
    search_cache_hits: num(t.search_cache_hits),
    search_degraded_queries: num(t.search_degraded_queries),
    search_unavailable_queries: num(t.search_unavailable_queries),
    provider_health: ph,
    primary_attribution: t.primary_attribution ?? null,
    reason: t.reason ?? null,
    error: t.error ?? null,
  }
}

/** Did this run actually search? (skipped / deps-missing / zero executed queries = no) */
function attempted(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.skipped === true) return false
  return num(entry.queries) > 0
}

function llmFailureCount(entry) {
  const by = entry?.extraction_failed_by_class || entry?.stage_ledger?.extraction_failed_by_class || {}
  let n = 0
  for (const [k, v] of Object.entries(by)) if (LLM_FAILURE_CLASSES.has(k)) n += num(v)
  return n
}

/**
 * PURE: fold one lane run's telemetry into the rolling store.
 *
 * @param {object|null} prev  previous store value
 * @param {object} entry      raw lane telemetry, a run record, or a ring entry
 *                            ({ at, profile_id, ok, skipped?, queries, pages,
 *                              fetched, extracted, stored, reason, error, … })
 * @returns {{ totals:object, recent:Array, updated_at:string|null }}
 */
export function buildWebLaneHealthUpdate(prev, entry = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const prevTotals = base.totals && typeof base.totals === 'object' ? base.totals : {}
  const slim = buildWebLaneRingEntry(entry)
  const ran = attempted(slim)
  const totals = {
    runs: num(prevTotals.runs) + 1,
    // zero_page_runs: queries RAN and nothing came back (weblane-1: a skipped
    // or deps-missing run has no query and is counted under skipped/no_crawl).
    zero_page_runs: num(prevTotals.zero_page_runs) + (ran && slim.pages === 0 ? 1 : 0),
    // zero_extract_runs: pages were FETCHED and nothing was extracted.
    zero_extract_runs: num(prevTotals.zero_extract_runs) + (ran && slim.fetched > 0 && slim.extracted === 0 ? 1 : 0),
    skipped_runs: num(prevTotals.skipped_runs) + (slim.skipped ? 1 : 0),
    no_crawl_runs: num(prevTotals.no_crawl_runs) + (!slim.skipped && !ran ? 1 : 0),
    stored_total: num(prevTotals.stored_total) + slim.stored,
  }
  const recent = [slim, ...(Array.isArray(base.recent) ? base.recent : [])].slice(0, RECENT_CAP)
  return { totals, recent, updated_at: slim.at ?? base.updated_at ?? null }
}

/**
 * PURE: judge the recent runs.
 *
 *   dead             enough JUDGEABLE runs (queries actually executed) and every
 *                    one produced zero search pages or errored — the SEARCH layer.
 *   extraction_dead  enough judgeable runs, every one fetched pages and
 *                    extracted nothing, and at least one run recorded an LLM-
 *                    class extraction failure — the EXTRACTION layer. Thin pages
 *                    alone (page_too_short) never make this verdict.
 *
 * Skipped (time budget) and no-crawl (deps missing / zero queries) runs are
 * COUNTED and REPORTED, never judged (weblane-1). The judged window is the
 * last `lastN` judgeable runs within the ring.
 *
 * @param {object|null} store
 * @param {{ lastN?:number, minRuns?:number }} [opts]
 */
export function summarizeRecentWebLane(store, { lastN = JUDGE_LAST_N, minRuns = MIN_RUNS_TO_JUDGE } = {}) {
  const all = Array.isArray(store?.recent) ? store.recent : []
  const window = all.slice(0, Math.max(lastN, 0) * 4 || lastN)
  const skipped = window.filter((r) => r?.skipped === true).length
  const noCrawl = window.filter((r) => r && r.skipped !== true && !attempted(r)).length
  const recent = all.filter((r) => attempted(r)).slice(0, lastN)
  const judged = recent.length
  const zeroPage = recent.filter((r) => num(r?.pages) === 0).length
  const zeroExtract = recent.filter((r) => num(r?.fetched) > 0 && num(r?.extracted) === 0).length
  const errored = recent.filter((r) => r?.error).length
  const stored = recent.reduce((n, r) => n + num(r?.stored), 0)
  const fetched = recent.reduce((n, r) => n + num(r?.fetched), 0)
  const extracted = recent.reduce((n, r) => n + num(r?.extracted), 0)
  const failedByClass = {}
  let llmFailures = 0
  for (const r of recent) {
    const by = r?.extraction_failed_by_class || r?.stage_ledger?.extraction_failed_by_class || {}
    for (const [k, v] of Object.entries(by)) failedByClass[k] = num(failedByClass[k]) + num(v)
    llmFailures += llmFailureCount(r)
  }
  let dominant = null
  let dominantN = 0
  for (const [k, v] of Object.entries(failedByClass)) {
    if (!LLM_FAILURE_CLASSES.has(k)) continue
    if (v > dominantN) { dominant = k; dominantN = v }
  }
  const reasons = [...new Set(recent.map((r) => r?.error || r?.reason).filter(Boolean))].slice(0, 4)
  const attributions = {}
  for (const r of recent) if (r?.primary_attribution) attributions[r.primary_attribution] = num(attributions[r.primary_attribution]) + 1
  const dead = judged >= minRuns && zeroPage === judged
  const extractionDead = !dead && judged >= minRuns && zeroExtract === judged && llmFailures > 0
  // Provider health across the judged window: the WORST verdict wins, so one
  // healthy run keeps the layer 'degraded' rather than 'unavailable'.
  const searchVerdicts = recent.map((r) => r?.provider_health?.search).filter(Boolean)
  const llmVerdicts = recent.map((r) => r?.provider_health?.llm).filter(Boolean)
  const worst = (list, order) => {
    if (!list.length) return 'unknown'
    let best = null
    for (const v of list) {
      const i = order.indexOf(v)
      if (i === -1) continue
      if (best === null || i > order.indexOf(best)) best = v
    }
    return best ?? 'unknown'
  }
  const searchHealth = dead ? 'unavailable' : worst(searchVerdicts, ['healthy', 'unknown', 'degraded', 'unavailable'])
  const llmHealth = extractionDead
    ? 'unavailable'
    : (llmVerdicts.length ? (llmVerdicts.every((v) => v === 'unavailable') ? 'unavailable' : (llmVerdicts.some((v) => v === 'healthy') ? 'healthy' : 'unknown')) : 'unknown')
  const newest = recent[0]?.at ?? all[0]?.at ?? null
  const oldest = recent.length ? recent[recent.length - 1]?.at ?? null : null
  return {
    judged,
    skipped,
    no_crawl: noCrawl,
    zero_page: zeroPage,
    zero_extract: zeroExtract,
    errored,
    stored,
    fetched,
    extracted,
    reasons,
    extraction_failed_by_class: failedByClass,
    dominant_extraction_failure: dominant,
    by_attribution: attributions,
    provider_health: { search: searchHealth, llm: llmHealth },
    window: { newest_at: newest, oldest_at: oldest },
    dead,
    extraction_dead: extractionDead,
  }
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/**
 * One-time, idempotent cleanup of the pre-bounded-store per-profile rows
 * (`web_lane_last_run:<profileId>`, unbounded, never cleaned up — see the
 * module doc). Guarded by a flag row so a hot path (recordWebLaneRun runs on
 * every live crawl) pays one extra indexed lookup forever after, not a scan.
 * Best-effort: a failure here must never fail a crawl or a read.
 */
async function purgeLegacyLastRunRowsOnce(db) {
  try {
    const flag = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(LEGACY_LAST_RUN_PURGED_FLAG_KEY)
    if (flag?.value) return
    await db.prepare('DELETE FROM system_kv WHERE key LIKE ?').run(`${LEGACY_LAST_RUN_KV_PREFIX}%`)
    await upsertKv(db, LEGACY_LAST_RUN_PURGED_FLAG_KEY, 'true', new Date().toISOString())
  } catch { /* best-effort cleanup; never blocks a crawl or a read */ }
}

/** Read the rolling web-lane health store (Sam diagnostics / Anya tools). */
export async function getWebLaneHealth(db) {
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

/** Read the bounded last-run store: { [profileId]: record }. Never throws. */
async function readLastRunStore(db) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(LAST_RUN_KV_KEY)
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Keep only the LAST_RUN_MAX_PROFILES most-recently-run profiles (by `at`),
 *  evicting the oldest first — the LRU cap that replaces one permanent
 *  system_kv row per profile ever crawled (Amy's reaped synthetics included). */
function pruneLastRunStore(store) {
  const ids = Object.keys(store)
  if (ids.length <= LAST_RUN_MAX_PROFILES) return store
  const keep = new Set(
    ids
      .map((id) => ({ id, at: Date.parse(store[id]?.at ?? '') || 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, LAST_RUN_MAX_PROFILES)
      .map((r) => r.id)
  )
  const next = {}
  for (const id of ids) if (keep.has(id)) next[id] = store[id]
  return next
}

/**
 * Read one profile's LAST full lane-run record out of the bounded last-run
 * store (system_kv `web_lane_last_runs`). Returns null when none was recorded
 * or the profile aged out of the LRU cap.
 *
 * @param {object} db
 * @param {string} profileId
 * @returns {Promise<object|null>} the record from buildWebLaneRunRecord
 */
export async function getLastWebLaneRun(db, profileId) {
  if (!db?.prepare || !profileId) return null
  try {
    await ensureKv(db)
    const store = await readLastRunStore(db)
    const parsed = store[profileKey(profileId)]
    return parsed && typeof parsed === 'object' ? { ...parsed, recorded_at: parsed.at ?? null } : null
  } catch {
    return null
  }
}

async function upsertKv(db, key, value, now) {
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

/**
 * Record one live lane run. Best-effort: never throws (health telemetry must
 * never fail a crawl). Writes the bounded ring entry AND upserts the
 * profile's full last-run record into the bounded, LRU-capped last-run store.
 *
 * @param {object} db
 * @param {object} args { profileId, telemetry, at?, trigger? } — telemetry is
 *                      run.web_lane from runProfileDiscoveryLive.
 */
export async function recordWebLaneRun(db, { profileId = null, telemetry = null, at = null, trigger = null } = {}) {
  if (!db?.prepare || !telemetry || typeof telemetry !== 'object') return { skipped: true }
  try {
    const when = at ?? new Date().toISOString()
    const record = buildWebLaneRunRecord(telemetry, { profileId, at: when, trigger })
    await ensureKv(db)
    await purgeLegacyLastRunRowsOnce(db)
    const prev = await getWebLaneHealth(db)
    const next = buildWebLaneHealthUpdate(prev, record)
    const now = next.updated_at || when
    await upsertKv(db, KV_KEY, JSON.stringify(next), now)
    if (profileId) {
      try {
        const store = await readLastRunStore(db)
        store[profileKey(profileId)] = record
        await upsertKv(db, LAST_RUN_KV_KEY, JSON.stringify(pruneLastRunStore(store)), now)
      } catch (err) {
        log.warn('web-lane last-run record failed (non-fatal)', { profile: profileId, error: err?.message })
      }
    }
    return { ok: true }
  } catch (err) {
    log.warn('web-lane health record failed (non-fatal)', { profile: profileId, error: err?.message })
    return { ok: false, error: err?.message }
  }
}

export default {
  KV_KEY,
  LAST_RUN_KV_KEY,
  LAST_RUN_MAX_PROFILES,
  LEGACY_LAST_RUN_KV_PREFIX,
  RECENT_CAP,
  JUDGE_LAST_N,
  MIN_RUNS_TO_JUDGE,
  buildWebLaneRunRecord,
  buildWebLaneRingEntry,
  buildWebLaneHealthUpdate,
  summarizeRecentWebLane,
  getWebLaneHealth,
  getLastWebLaneRun,
  recordWebLaneRun,
}
