/**
 * recallScorecard.js — the per-stage funnel for ONE question: where does a
 * profile's discovery actually lose its funding?
 *
 *   queries generated → executed (vs skipped for budget) → pages fetched →
 *   candidates extracted (vs extraction failed, by class) → gate rejections
 *   (reality / eligibility / need / apply target) → held for review →
 *   qualified admitted → match rows in surfaced lanes → surfaced qualifying /
 *   actionable / awardable / applyable-typed (vs the profile's result target)
 *   → pipeline rows by status → applications by state.
 *
 * WHY (result-quality PR4, 2026-09-17). Every number the crawler reports was
 * already recorded somewhere — the web lane's stage ledger, the coverage
 * audit, the match store, the pipeline — but nothing laid them end to end, so
 * "recall" was argued from single counts. Measured on the deployed catalog the
 * day this shipped: three real profiles each planned 28 queries and executed
 * 7 (21 skipped for budget); one extracted 24 candidates and admitted 0 (9
 * refused at apply target, 5 at eligibility, 3 at reality, 6 held for
 * review), one extracted 0 (LLM quota), one lost 9 at eligibility. A lever
 * that widens the top of that funnel cannot be credited unless the stages
 * below it are visible on the same card.
 *
 * WHAT "BETTER" MEANS here, so a before/after cannot be gamed by a bigger
 * pile of candidates: the primary outcome is `surfaced.awardable` and
 * `surfaced.applyable_typed` (the counts the owner recognises as funding);
 * `stages.qualified_admitted` is the per-run secondary; `candidates_extracted`
 * and `queries_executed` are diagnostic only. Two snapshots compare only when
 * both carry provider_health `healthy` and the same `code_version` family.
 *
 * READ-ONLY over profiles / matches / pipeline. Its only writes are the two
 * system_kv snapshot keys, bounded.
 */
// The registry's quoted lane literals ('crawler-os', …) — an allow-list, no caller input.
import { SURFACED_MATCHER_VERSIONS_SQL as SURFACED_LANES_ALLOWED_SQL } from '../../config/matchSurfacing.js'
import { hasPositiveFourTruthProof } from '../../config/fundingTruthPolicy.js'
import { buildMetricEnvelope, resolveCodeVersion } from '../observability/metricEnvelope.js'
import { ORIGIN_CREATED_BY as AMY_ORIGIN_CREATED_BY } from '../amy/amyConstants.js'
import { getLastWebLaneRun } from './webLaneHealth.js'
import { auditProfileResultCoverage } from './profileResultCoverageAudit.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:recallScorecard')

export const RECALL_SCORECARD_KV_KEY = 'recall_scorecard_last_run'
export const RECALL_SCORECARD_HISTORY_KV_KEY = 'recall_scorecard_history'
export const RECALL_SCORECARD_HISTORY_CAP = 14
export const DEFAULT_FLEET_LIMIT = 50
const MAX_FLEET_LIMIT = 200
/** Skipped queries carried into a profile's next heal run; capped so the plan's own core still executes. */
export const CARRY_OVER_LIMIT = 4
/** A run that skipped at least this share of its plan for budget is "budget starved". */
export const BUDGET_STARVED_SHARE = 0.5

const AMY_SYNTHETIC_NAME_PREFIX = 'Amy Synthetic'

export const RECALL_BLOCKER = Object.freeze({
  NO_RUN: 'no_run',
  EXTRACTION_DEAD: 'extraction_dead',
  SEARCH_UNAVAILABLE: 'search_unavailable',
  BUDGET_STARVED: 'budget_starved',
  GATED_AT_REALITY: 'gated_at_reality',
  GATED_AT_ELIGIBILITY: 'gated_at_eligibility',
  GATED_AT_NEED: 'gated_at_need',
  GATED_AT_APPLY_TARGET: 'gated_at_apply_target',
  HELD_FOR_REVIEW: 'held_for_review',
  ADMITTED_BELOW_TARGET: 'admitted_below_target',
  MET_TARGET: 'met_target',
  UNCONFIGURED: 'unconfigured',
  UNKNOWN: 'unknown',
})

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function share(part, whole) {
  const w = num(whole)
  return w > 0 ? Math.round((num(part) / w) * 1000) / 1000 : null
}

/** The lane record's stage counters, normalized. PURE. */
export function stageCountsFromLane(record) {
  const r = record && typeof record === 'object' ? record : null
  const stage = r?.stage_ledger && typeof r.stage_ledger === 'object' ? r.stage_ledger : {}
  const ledger = r?.query_ledger && typeof r.query_ledger === 'object' ? r.query_ledger : {}
  const planned = num(stage.query_generated ?? r?.queries_planned)
  const executed = num(stage.provider_attempted ?? r?.queries_executed ?? (Array.isArray(r?.queries) ? r.queries.length : 0))
  const skipped = num(stage.query_skipped_budget ?? (Array.isArray(ledger.skipped_budget) ? ledger.skipped_budget.length : 0))
  const byClass = stage.extraction_failed_by_class && typeof stage.extraction_failed_by_class === 'object'
    ? { ...stage.extraction_failed_by_class }
    : {}
  return {
    queries_generated: planned,
    queries_executed: executed,
    queries_skipped_budget: skipped,
    budget_skipped_share: share(skipped, planned),
    pages_fetched: num(r?.fetched ?? stage.response_received),
    candidates_extracted: num(stage.candidates_extracted ?? r?.extracted),
    extraction_failed: num(stage.extraction_failed),
    extraction_failed_by_class: byClass,
    gate_rejected: {
      reality: num(stage.reality_rejected),
      eligibility: num(stage.eligibility_rejected),
      need: num(stage.need_match_rejected),
      apply_target: num(stage.apply_target_rejected),
    },
    review_held: num(stage.review_held),
    catalog_refused: num(stage.catalog_refused),
    qualified_admitted: num(stage.qualified_admitted),
    stored: num(r?.stored),
  }
}

/**
 * The ONE stage that bound this profile's recall, in funnel order. PURE.
 *
 * Reads the lane record (last live web-lane run) and the coverage audit
 * (what is surfaced now vs the target). A profile that met its target is
 * `met_target` whatever its run looked like; an unconfigured profile is not a
 * recall problem; no run / a dead provider is named before any budget or gate
 * claim; budget starvation is named only when the run could extract at all;
 * among the gates, the largest rejection count wins; candidates that were
 * all held for review are `held_for_review`; admitted rows that still leave
 * the profile short are `admitted_below_target`.
 */
export function classifyRecallBlocker({ lane = null, audit = null } = {}) {
  const a = audit && typeof audit === 'object' ? audit : null
  if (a?.unconfigured === true) return { blocker: RECALL_BLOCKER.UNCONFIGURED, detail: a.missing_prerequisites ?? [] }
  const belowTarget = a ? a.below_result_target === true || a.below_applyable_floor === true : null
  if (a && belowTarget === false && num(a.surfaced_awardable) > 0) {
    return { blocker: RECALL_BLOCKER.MET_TARGET, detail: { awardable: num(a.surfaced_awardable), target: a.result_target ?? null } }
  }
  const r = lane && typeof lane === 'object' ? lane : null
  if (!r || r.skipped === true || r.ok === false) return { blocker: RECALL_BLOCKER.NO_RUN, detail: r?.reason ?? null }
  const ph = r.provider_health && typeof r.provider_health === 'object' ? r.provider_health : {}
  const attribution = String(r.primary_attribution ?? '')
  if (ph.search === 'unavailable') return { blocker: RECALL_BLOCKER.SEARCH_UNAVAILABLE, detail: attribution || null }
  const s = stageCountsFromLane(r)
  if (ph.llm === 'unavailable' || r.extraction_available === false || attribution.startsWith('extraction_failed:') ||
      (s.pages_fetched > 0 && s.candidates_extracted === 0 && s.extraction_failed > 0)) {
    return { blocker: RECALL_BLOCKER.EXTRACTION_DEAD, detail: s.extraction_failed_by_class }
  }
  if (s.candidates_extracted === 0) {
    if (s.budget_skipped_share !== null && s.budget_skipped_share >= BUDGET_STARVED_SHARE) {
      return { blocker: RECALL_BLOCKER.BUDGET_STARVED, detail: { skipped: s.queries_skipped_budget, planned: s.queries_generated } }
    }
    return { blocker: RECALL_BLOCKER.UNKNOWN, detail: 'no candidates and no dominant cause recorded' }
  }
  if (s.qualified_admitted === 0) {
    const gates = [
      [RECALL_BLOCKER.GATED_AT_APPLY_TARGET, s.gate_rejected.apply_target],
      [RECALL_BLOCKER.GATED_AT_ELIGIBILITY, s.gate_rejected.eligibility],
      [RECALL_BLOCKER.GATED_AT_REALITY, s.gate_rejected.reality],
      [RECALL_BLOCKER.GATED_AT_NEED, s.gate_rejected.need],
    ].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1])
    if (gates.length > 0 && gates[0][1] >= s.review_held) {
      return { blocker: gates[0][0], detail: { rejected: gates[0][1], of_extracted: s.candidates_extracted, review_held: s.review_held } }
    }
    if (s.review_held > 0) return { blocker: RECALL_BLOCKER.HELD_FOR_REVIEW, detail: { review_held: s.review_held, of_extracted: s.candidates_extracted } }
    if (s.budget_skipped_share !== null && s.budget_skipped_share >= BUDGET_STARVED_SHARE) {
      return { blocker: RECALL_BLOCKER.BUDGET_STARVED, detail: { skipped: s.queries_skipped_budget, planned: s.queries_generated } }
    }
    return { blocker: RECALL_BLOCKER.UNKNOWN, detail: 'candidates extracted, none admitted, no gate recorded' }
  }
  if (belowTarget === true) {
    return { blocker: RECALL_BLOCKER.ADMITTED_BELOW_TARGET, detail: { admitted: s.qualified_admitted, awardable: num(a?.surfaced_awardable), target: a?.result_target ?? null } }
  }
  if (a && belowTarget === false) return { blocker: RECALL_BLOCKER.MET_TARGET, detail: { awardable: num(a.surfaced_awardable) } }
  return { blocker: RECALL_BLOCKER.UNKNOWN, detail: 'admitted candidates; no coverage audit to judge the target' }
}

/**
 * The queries a run skipped for budget, to carry into this profile's NEXT heal
 * run as `extraQueries`. PURE. The web lane places extra queries at the head
 * of a shortfall plan, so the cap keeps room for the plan's own anchors and
 * rotating slot (a 7-query budget executes 4 carried + 3 core). Nothing is
 * carried from a run whose extraction was dead — those queries were never
 * evaluated, and re-running them under the same outage buys nothing. Dedupes
 * by normalized text and drops directive/seed pseudo-queries.
 */
export function carryOverSkippedQueries(record, { limit = CARRY_OVER_LIMIT } = {}) {
  const r = record && typeof record === 'object' ? record : null
  if (!r || r.ok === false || r.skipped === true || r.extraction_available === false) return []
  if (String(r.primary_attribution ?? '').startsWith('extraction_failed:')) return []
  if (r.provider_health?.llm === 'unavailable' || r.provider_health?.search === 'unavailable') return []
  const skipped = Array.isArray(r.query_ledger?.skipped_budget) ? r.query_ledger.skipped_budget : []
  const out = []
  const seen = new Set()
  for (const entry of skipped) {
    const q = String(entry?.query ?? entry ?? '').replace(/\s+/g, ' ').trim()
    if (!q || /^seed:/i.test(q)) continue
    const key = q.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q)
    if (out.length >= Math.max(0, limit)) break
  }
  return out
}

async function countMatchRows(db, profileId) {
  let rows
  try {
    rows = await db.prepare(
      `SELECT LOWER(COALESCE(m.match_decision, '')) AS decision, m.match_explain_json,
              (m.matcher_version IN ${SURFACED_LANES_ALLOWED_SQL}) AS surfaced_lane
         FROM profile_opportunity_matches m
        WHERE m.profile_id = ?`,
    ).all(profileId)
  } catch {
    return null // match store absent in this schema → UNKNOWN, never 0
  }
  const out = { surfaced_lanes: { accept: 0, review: 0, reject: 0, other: 0 }, unsurfaced_lanes: 0, proven_direct_accepts: 0 }
  for (const row of rows || []) {
    const inSurfaced = row.surfaced_lane === true || Number(row.surfaced_lane) === 1
    if (!inSurfaced) { out.unsurfaced_lanes += 1; continue }
    const d = String(row.decision || '')
    if (d === 'accept' || d === 'review' || d === 'reject') out.surfaced_lanes[d] += 1
    else out.surfaced_lanes.other += 1
    if (d === 'accept' && hasPositiveFourTruthProof(row)) out.proven_direct_accepts += 1
  }
  return out
}

async function countByColumn(db, sql, profileId) {
  try {
    const rows = await db.prepare(sql).all(profileId)
    const out = {}
    for (const row of rows || []) out[String(row.k ?? 'unknown')] = num(row.n)
    return out
  } catch {
    return null // table absent in this schema → UNKNOWN, never 0
  }
}

function sum(counts) {
  return counts ? Object.values(counts).reduce((t, n) => t + num(n), 0) : null
}

/**
 * One profile's scorecard. `audit`/`lane` may be supplied (the sweep already
 * has both) to avoid re-loading; otherwise they are read here.
 */
export async function buildProfileRecallScorecard(db, profileId, { audit = null, lane = null, now = new Date() } = {}) {
  const pid = String(profileId ?? '').trim()
  if (!db?.prepare || !pid) throw new Error('buildProfileRecallScorecard: db and profileId are required')
  const laneRecord = lane ?? await getLastWebLaneRun(db, pid)
  let coverage = audit
  if (!coverage) {
    try { coverage = await auditProfileResultCoverage(db, pid) } catch (err) {
      log.warn('coverage audit unavailable for recall scorecard (non-fatal)', { profile: pid, error: err?.message })
      coverage = null
    }
  }
  const stages = stageCountsFromLane(laneRecord)
  const catalog = await countMatchRows(db, pid)
  const pipeline = await countByColumn(db, `SELECT COALESCE(status, 'unknown') AS k, COUNT(*) AS n FROM grants WHERE profile_id = ? GROUP BY status`, pid)
  const applications = await countByColumn(db, `SELECT COALESCE(state, 'unknown') AS k, COUNT(*) AS n FROM vnext_applications WHERE profile_id = ? GROUP BY state`, pid)
  const { blocker, detail } = classifyRecallBlocker({ lane: laneRecord, audit: coverage })
  return {
    profile_id: pid,
    measured_at: now.toISOString(),
    lane: laneRecord
      ? {
          at: laneRecord.at ?? laneRecord.recorded_at ?? null,
          trigger: laneRecord.trigger ?? null,
          ok: laneRecord.ok !== false,
          skipped: laneRecord.skipped === true,
          provider_health: laneRecord.provider_health
            ? { search: laneRecord.provider_health.search ?? 'unknown', llm: laneRecord.provider_health.llm ?? 'unknown' }
            : { search: 'unknown', llm: 'unknown' },
          primary_attribution: laneRecord.primary_attribution ?? null,
          extraction_available: laneRecord.extraction_available ?? null,
        }
      : null,
    stages,
    catalog,
    surfaced: coverage
      ? {
          qualifying: num(coverage.surfaced_qualifying),
          actionable: num(coverage.surfaced_actionable),
          awardable: num(coverage.surfaced_awardable),
          applyable_typed: coverage.surfaced_applyable_typed ?? null,
          result_target: coverage.result_target ?? null,
          below_result_target: coverage.below_result_target === true,
          applyable_floor: coverage.applyable_floor ?? null,
          below_applyable_floor: coverage.below_applyable_floor === true,
          gaps: Array.isArray(coverage.gaps) ? coverage.gaps.slice(0, 8) : [],
        }
      : null,
    pipeline: {
      by_status: pipeline,
      total: sum(pipeline),
      // `submitted` in the pipeline table is an INTERNAL record. Externally
      // confirmed submissions are proven per task by Hamilton's submission-proof
      // predicate and are not aggregated here — reported UNKNOWN, never as 0.
      submitted_internal: pipeline ? num(pipeline.submitted) : null,
      verified_external_submissions: null,
    },
    applications: { by_state: applications, total: sum(applications) },
    carry_over_queries: carryOverSkippedQueries(laneRecord).length,
    binding_constraint: { blocker, detail },
  }
}

/** Real, active profiles — Amy's synthetic cohort never enters the scorecard. */
async function listRealActiveProfiles(db, limit) {
  const isPg = db?.dialect === 'postgres'
  const lim = Math.max(1, Math.min(Number(limit) || DEFAULT_FLEET_LIMIT, MAX_FLEET_LIMIT))
  const sql = `SELECT id, display_name, primary_type, last_discovery_at
                 FROM profiles
                WHERE (status IS NULL OR status = 'active')
                  AND deleted_at IS NULL
                  AND COALESCE(created_by, '') <> ?
                  AND COALESCE(display_name, '') NOT LIKE ?
                ORDER BY last_discovery_at DESC NULLS LAST, created_at DESC
                LIMIT ${isPg ? '$3' : '?'}`
  try {
    return await db.prepare(sql).all(AMY_ORIGIN_CREATED_BY, `${AMY_SYNTHETIC_NAME_PREFIX}%`, lim)
  } catch {
    // Minimal schemas (no deleted_at / last_discovery_at / primary_type columns).
    return db.prepare(
      `SELECT id, display_name FROM profiles
        WHERE (status IS NULL OR status = 'active') AND COALESCE(created_by, '') <> ? AND COALESCE(display_name, '') NOT LIKE ?
        LIMIT ${isPg ? '$3' : '?'}`,
    ).all(AMY_ORIGIN_CREATED_BY, `${AMY_SYNTHETIC_NAME_PREFIX}%`, lim)
  }
}

function compactRow(card, profile) {
  return {
    profile_id: card.profile_id,
    primary_type: profile?.primary_type ?? null,
    lane_at: card.lane?.at ?? null,
    llm: card.lane?.provider_health?.llm ?? 'unknown',
    queries_executed: card.stages.queries_executed,
    queries_skipped_budget: card.stages.queries_skipped_budget,
    candidates_extracted: card.stages.candidates_extracted,
    qualified_admitted: card.stages.qualified_admitted,
    awardable: card.surfaced?.awardable ?? null,
    applyable_typed: card.surfaced?.applyable_typed ?? null,
    result_target: card.surfaced?.result_target ?? null,
    proven_direct_accepts: card.catalog?.proven_direct_accepts ?? null,
    pipeline_total: card.pipeline.total,
    blocker: card.binding_constraint.blocker,
    carry_over_queries: card.carry_over_queries,
  }
}

/**
 * Fleet roll-up over real active profiles (bounded). `audits` from the sweep
 * are reused when supplied (keyed by profile_id) so the sweep pays the audit
 * cost once.
 */
export async function buildFleetRecallScorecard(db, { limit = DEFAULT_FLEET_LIMIT, audits = null, now = new Date() } = {}) {
  const startedAt = now.toISOString()
  const profiles = await listRealActiveProfiles(db, limit)
  const auditById = new Map()
  for (const a of Array.isArray(audits) ? audits : []) if (a?.profile_id) auditById.set(String(a.profile_id), a)
  const rows = []
  const failures = []
  for (const p of profiles) {
    try {
      const card = await buildProfileRecallScorecard(db, p.id, { audit: auditById.get(String(p.id)) ?? null, now })
      rows.push(compactRow(card, p))
    } catch (err) {
      failures.push({ profile_id: p.id, error: String(err?.message || err) })
    }
  }
  const blockers = {}
  const totals = { queries_executed: 0, queries_skipped_budget: 0, candidates_extracted: 0, qualified_admitted: 0, awardable: 0, proven_direct_accepts: 0 }
  let extractionAlive = 0
  let admittedZeroWhileAlive = 0
  let budgetStarved = 0
  let llmKnown = 0
  for (const r of rows) {
    blockers[r.blocker] = (blockers[r.blocker] || 0) + 1
    totals.queries_executed += r.queries_executed
    totals.queries_skipped_budget += r.queries_skipped_budget
    totals.candidates_extracted += r.candidates_extracted
    totals.qualified_admitted += r.qualified_admitted
    totals.awardable += num(r.awardable)
    totals.proven_direct_accepts += num(r.proven_direct_accepts)
    if (r.llm !== 'unknown') llmKnown += 1
    if (r.llm === 'healthy' || (r.candidates_extracted > 0)) {
      extractionAlive += 1
      if (r.qualified_admitted === 0) admittedZeroWhileAlive += 1
    }
    const planned = r.queries_executed + r.queries_skipped_budget
    if (planned > 0 && r.queries_skipped_budget / planned >= BUDGET_STARVED_SHARE) budgetStarved += 1
  }
  const envelope = buildMetricEnvelope({
    window: { kind: 'point_in_time', start: startedAt, end: new Date().toISOString(), label: 'recall scorecard — real active profiles' },
    population: { kind: 'active_profiles', description: `active, non-Amy profiles, newest discovery first, LIMIT ${limit}`, selector: 'recallScorecard.listRealActiveProfiles' },
    evaluated: rows.length,
    unevaluated: failures.length,
    providerHealth: { llm_known: llmKnown, extraction_alive_runs: extractionAlive },
    freshnessAt: startedAt,
    codeVersion: resolveCodeVersion(),
    extra: { limit, definition_of_better: 'surfaced.awardable and surfaced.applyable_typed (primary); stages.qualified_admitted (secondary); candidates_extracted / queries_executed diagnostic only' },
  })
  return {
    generated_at: startedAt,
    profiles_scanned: profiles.length,
    profiles_measured: rows.length,
    failures,
    totals,
    shares: {
      budget_starved: share(budgetStarved, rows.length),
      extraction_alive: share(extractionAlive, rows.length),
      admitted_zero_while_alive: share(admittedZeroWhileAlive, extractionAlive),
      below_result_target: share(rows.filter((r) => r.result_target && num(r.awardable) < num(r.result_target)).length, rows.length),
    },
    blockers,
    rows,
    metric_envelope: envelope,
  }
}

async function ensureKv(db) {
  try { await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run() } catch { /* exists */ }
}

async function upsertKv(db, key, value, now) {
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

/** Persist a fleet scorecard (last + bounded history). Best-effort; never throws. */
export async function recordRecallScorecard(db, fleet) {
  if (!db?.prepare || !fleet || typeof fleet !== 'object') return { ok: false, skipped: true }
  try {
    await ensureKv(db)
    const now = new Date().toISOString()
    await upsertKv(db, RECALL_SCORECARD_KV_KEY, JSON.stringify({ ...fleet, recorded_at: now }), now)
    let history = []
    try {
      const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(RECALL_SCORECARD_HISTORY_KV_KEY)
      const parsed = row?.value ? JSON.parse(row.value) : []
      history = Array.isArray(parsed) ? parsed : []
    } catch { history = [] }
    history.unshift({
      generated_at: fleet.generated_at,
      code_version: fleet.metric_envelope?.code_version ?? null,
      totals: fleet.totals,
      shares: fleet.shares,
      blockers: fleet.blockers,
      rows: (fleet.rows || []).map((r) => ({
        profile_id: r.profile_id, awardable: r.awardable, applyable_typed: r.applyable_typed,
        qualified_admitted: r.qualified_admitted, candidates_extracted: r.candidates_extracted, blocker: r.blocker, llm: r.llm,
      })),
    })
    await upsertKv(db, RECALL_SCORECARD_HISTORY_KV_KEY, JSON.stringify(history.slice(0, RECALL_SCORECARD_HISTORY_CAP)), now)
    return { ok: true, history_depth: Math.min(history.length, RECALL_SCORECARD_HISTORY_CAP) }
  } catch (err) {
    log.warn('recall scorecard persist failed (non-fatal)', { error: err?.message })
    return { ok: false, error: String(err?.message || err) }
  }
}

export async function getLastRecallScorecard(db) {
  if (!db?.prepare) return null
  try {
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(RECALL_SCORECARD_KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? { ...parsed, updated_at: row.updated_at ?? null } : null
  } catch {
    return null
  }
}

export async function getRecallScorecardHistory(db) {
  if (!db?.prepare) return []
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(RECALL_SCORECARD_HISTORY_KV_KEY)
    const parsed = row?.value ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default {
  RECALL_BLOCKER,
  stageCountsFromLane,
  classifyRecallBlocker,
  carryOverSkippedQueries,
  buildProfileRecallScorecard,
  buildFleetRecallScorecard,
  recordRecallScorecard,
  getLastRecallScorecard,
  getRecallScorecardHistory,
}
