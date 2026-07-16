/**
 * coverageGapScoreboard.js — the FLEET-WIDE roll-up of the per-profile
 * Coverage & Evidence dashboard (owner directive 2026-07-06: "Have Amy, Anya,
 * and Sam learn from the Coverage & Evidence Dashboard. Let Amy create tasks
 * from gaps found in these crawls instead of randomly.")
 *
 * buildCoverageEvidence() answers "what did we search / what did we miss" for
 * ONE profile. This module runs it across the active fleet (bounded) and
 * aggregates the gap statements by (lane, statement-class) so the agents can
 * consume a single prioritized scoreboard instead of anecdotes:
 *
 *   PRODUCE  — buildFleetGapScoreboard(db) scans active profiles, classifies
 *              every gap, aggregates by class, and persists the scoreboard to
 *              system_kv `coverage_gap_scoreboard` (UPDATE-then-INSERT,
 *              shim-safe — same pattern as enforceInvariants' observability
 *              record).
 *   CONSUME  — Amy (amyAgent) refreshes the scoreboard at the start of each
 *              training run: gap classes WEIGHT the synthetic-archetype cohort
 *              (weightCategoriesByGaps) so training concentrates where the
 *              real fleet hurts, and deriveAmyGapActions() splits the gaps
 *              into what Amy's own levers can act on vs the structural
 *              "adapter wishlist" only a code change can fix.
 *   OBSERVE  — Sam reads the scoreboard via the `coverage.gapScoreboard`
 *              registry check (staleness + dominant-gap alerts); Anya's 09:00
 *              owner report renders the top gaps + wishlist + what the agents
 *              changed overnight (Agent Observability Rule).
 *
 * READ-ONLY over profiles/matches: this module never re-scores, never mutates
 * profile data — its only write is the system_kv scoreboard.
 */

import { buildCoverageEvidence, LANES } from './coverageEvidenceService.js'
import {
  buildCoverageMatrix,
  listUncoveredCells,
  CRITICAL_NEEDS,
  DOCUMENTED_GAPS,
  cellKey,
} from '../crawler-os/coverageMatrix.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('services:coverageGapScoreboard')

/** system_kv key holding the fleet gap scoreboard. */
export const KV_KEY = 'coverage_gap_scoreboard'

/** A scoreboard older than this is STALE (Amy runs daily; 48h = two misses). */
export const STALE_MS = 48 * 60 * 60 * 1000

/** Bounds so a fleet scan can never run away. */
export const DEFAULT_SCAN_LIMIT = 100
const MAX_SCAN_LIMIT = 500
const MAX_STORED_GAPS = 100
const AFFECTED_PROFILE_ID_CAP = 25
export const WISHLIST_CAP = 10

/** Amy's synthetic profiles must never poison the FLEET scoreboard. */
const AMY_ORIGIN_CREATED_BY = 'agent:amy'
const AMY_SYNTHETIC_NAME_PREFIX = 'Amy Synthetic'

// ─────────────────────────────────────────────────────────────────────────────
// Gap classification — the (lane, statement-class) aggregation key.
// ─────────────────────────────────────────────────────────────────────────────

export const GAP_CLASSES = Object.freeze({
  /** A whole lane has ZERO adapters in the source registry (e.g. county_city). */
  NO_LANE_ADAPTER: 'no_lane_adapter',
  /** The lane has sources but every one was excluded for this profile. */
  LANE_EXCLUDED: 'lane_excluded',
  /** No state-specific source exists for the profile's state. */
  NO_STATE_SOURCE: 'no_state_source',
  /** No disease-specific source exists for a profile's health condition. */
  NO_DISEASE_SOURCE: 'no_disease_source',
  /** A disease source EXISTS in the registry but was not selected. */
  DISEASE_NOT_SELECTED: 'disease_source_not_selected',
  /** A declared profile need that no searched source covers. */
  NEED_UNCOVERED: 'need_uncovered',
  /**
   * A REGISTRY-LEVEL hole from the need×state coverage matrix: a critical
   * need × US state cell with zero dedicated sources (the ECF-gap class).
   * Fleet-INDEPENDENT — detected even when no live profile has hit it yet.
   */
  MATRIX_UNCOVERED_CRITICAL: 'matrix_uncovered_critical_cell',
  OTHER: 'other',
})

/**
 * Structural classes = a source ADAPTER is missing. Amy cannot write code, so
 * these become the prioritized "adapter wishlist" surfaced to the owner
 * instead of silently rotting.
 */
export const STRUCTURAL_GAP_CLASSES = Object.freeze(
  new Set([
    GAP_CLASSES.NO_LANE_ADAPTER,
    GAP_CLASSES.NO_STATE_SOURCE,
    GAP_CLASSES.NO_DISEASE_SOURCE,
    GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL,
  ]),
)

function factValue(gap) {
  const pf = String(gap?.profile_fact || '')
  const idx = pf.indexOf('=')
  return idx >= 0 ? pf.slice(idx + 1).trim() : ''
}

/**
 * PURE: classify one buildCoverageEvidence gap into a statement-class + the
 * distinguishing detail (state / condition / need / lane) so the SAME
 * real-world gap aggregates across profiles even though the raw statements
 * embed per-profile facts.
 */
export function classifyGap(gap = {}) {
  const statement = String(gap.statement || '')
  const lane = gap.lane || null
  if (/source adapters exist/i.test(statement)) {
    return { gap_class: GAP_CLASSES.NO_LANE_ADAPTER, detail: lane || 'unknown_lane' }
  }
  if (/^None of the \d+ known/i.test(statement)) {
    return { gap_class: GAP_CLASSES.LANE_EXCLUDED, detail: lane || 'unknown_lane' }
  }
  if (lane === 'state_programs' && /-specific state-programs source/i.test(statement)) {
    return { gap_class: GAP_CLASSES.NO_STATE_SOURCE, detail: factValue(gap) || 'unknown_state' }
  }
  if (lane === 'disease_specific' && /No disease-specific source lane exists/i.test(statement)) {
    return { gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: factValue(gap) || 'unknown_condition' }
  }
  if (lane === 'disease_specific' && /was not selected for this profile/i.test(statement)) {
    return { gap_class: GAP_CLASSES.DISEASE_NOT_SELECTED, detail: factValue(gap) || 'unknown_condition' }
  }
  if (/No searched source covers the profile need/i.test(statement)) {
    return { gap_class: GAP_CLASSES.NEED_UNCOVERED, detail: factValue(gap) || 'unknown_need' }
  }
  return { gap_class: GAP_CLASSES.OTHER, detail: statement.slice(0, 80) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

const LANE_LABEL = Object.fromEntries(LANES.map((l) => [l.lane, l.label]))

/**
 * PURE: fold per-profile Coverage & Evidence results into the scoreboard body.
 *
 * @param {Array<{profile_id:string, gaps?:Array, lanes?:Array, answer_next?:Array}>} results
 * @returns {{ gaps:Array, top_missing_lanes:Array, top_unanswered_fields:Array, adapter_wishlist:Array }}
 */
export function aggregateGapResults(results = []) {
  const byKey = new Map()
  const missingLaneCounts = new Map()
  const fieldAgg = new Map()

  for (const r of Array.isArray(results) ? results : []) {
    const pid = r?.profile_id ?? null
    for (const gap of Array.isArray(r?.gaps) ? r.gaps : []) {
      const { gap_class, detail } = classifyGap(gap)
      const key = `${gap.lane || 'any'}|${gap_class}|${detail}`
      const entry = byKey.get(key) || {
        lane: gap.lane || null,
        lane_label: gap.lane ? (LANE_LABEL[gap.lane] || gap.lane) : null,
        gap_class,
        detail,
        statement: gap.statement || '',
        suggested_action: gap.suggested_action || '',
        count: 0,
        affected_profiles: [],
      }
      entry.count += 1
      if (pid && entry.affected_profiles.length < AFFECTED_PROFILE_ID_CAP && !entry.affected_profiles.includes(pid)) {
        entry.affected_profiles.push(pid)
      }
      byKey.set(key, entry)
    }
    for (const laneRow of Array.isArray(r?.lanes) ? r.lanes : []) {
      if (laneRow?.status === 'missing' && laneRow.lane) {
        missingLaneCounts.set(laneRow.lane, (missingLaneCounts.get(laneRow.lane) || 0) + 1)
      }
    }
    for (const item of Array.isArray(r?.answer_next) ? r.answer_next : []) {
      const field = String(item?.field || '').trim()
      if (!field) continue
      const agg = fieldAgg.get(field) || { field, question: item.question || '', profiles: 0, blocked_matches: 0 }
      agg.profiles += 1
      agg.blocked_matches += Number(item.blocked_matches) || 0
      if (!agg.question && item.question) agg.question = item.question
      fieldAgg.set(field, agg)
    }
  }

  const gaps = [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, MAX_STORED_GAPS)
  const top_missing_lanes = [...missingLaneCounts.entries()]
    .map(([lane, profiles_missing]) => ({ lane, label: LANE_LABEL[lane] || lane, profiles_missing }))
    .sort((a, b) => b.profiles_missing - a.profiles_missing)
  const top_unanswered_fields = [...fieldAgg.values()]
    .sort((a, b) => b.profiles - a.profiles || b.blocked_matches - a.blocked_matches)
    .slice(0, 10)
  const adapter_wishlist = gaps
    .filter((g) => STRUCTURAL_GAP_CLASSES.has(g.gap_class))
    .slice(0, WISHLIST_CAP)
    .map((g) => ({
      lane: g.lane,
      gap_class: g.gap_class,
      detail: g.detail,
      statement: g.statement,
      affected_profiles_count: g.count,
      // The wishlist's CONSUMER (conditionSourceSearch) needs the ids, not just the
      // count: a candidate source it finds is queued per-profile, and
      // appendGapCandidates hard-drops any entry without a profile_id. Projecting
      // only the count is why a consumer written against this shape would queue
      // ZERO candidates while reporting success — the read-green-while-doing-nothing
      // class. Already capped at AFFECTED_PROFILE_ID_CAP upstream.
      affected_profiles: Array.isArray(g.affected_profiles) ? g.affected_profiles : [],
      suggested_action: g.suggested_action,
    }))

  return { gaps, top_missing_lanes, top_unanswered_fields, adapter_wishlist }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural matrix — the fleet-INDEPENDENT registry-level coverage check
// (backend/crawler-os/coverageMatrix.js). The per-profile gaps above only see
// holes a live profile has already hit; the matrix sees "no source can serve a
// TN disability profile" the moment the registry makes it true, even with an
// empty fleet. Its guard TEST is coverageMatrix.test.mjs; this section is the
// same truth surfaced to the agents (Amy wishlist / Sam / Anya's report).
// ─────────────────────────────────────────────────────────────────────────────

/** Matrix lane marker used on scoreboard/wishlist entries from this section. */
export const STRUCTURAL_MATRIX_LANE = 'structural_matrix'

/**
 * PURE (registry-only, no DB): compute the structural_matrix scoreboard
 * section from the need×state coverage matrix.
 *
 *   uncovered_critical_cells — critical need × state cells with zero DEDICATED
 *     sources. Should ALWAYS be empty (the coverageMatrix guard test fails the
 *     build otherwise); if one ever reaches a running fleet it becomes the
 *     highest-priority adapter-wishlist entries.
 *   undocumented_gap_cells — non-critical dedicated-tier holes NOT in the
 *     DOCUMENTED_GAPS backlog (same drift the guard test catches).
 */
export function buildStructuralMatrixSection() {
  const matrix = buildCoverageMatrix()
  const critical = new Set(CRITICAL_NEEDS)
  const dedicatedHoles = listUncoveredCells({ dedicatedOnly: true })
  const documented = new Set(DOCUMENTED_GAPS.map((g) => cellKey(g.need, g.state)))

  const uncovered_critical_cells = dedicatedHoles.filter(({ need }) => critical.has(need))
  const undocumented_gap_cells = dedicatedHoles.filter(
    ({ need, state }) => !critical.has(need) && !documented.has(cellKey(need, state)),
  )

  return {
    needs_checked: matrix.needs.length,
    states_checked: matrix.states.length,
    total_cells: matrix.stats.total_cells,
    // Wildcard tier: '*'-need national nets counted (planner semantics).
    uncovered_cells: matrix.stats.uncovered_cells,
    critical_needs: [...CRITICAL_NEEDS],
    uncovered_critical_cells,
    documented_gaps: DOCUMENTED_GAPS.length,
    undocumented_gap_cells,
  }
}

/**
 * PURE: map uncovered critical matrix cells to adapter-wishlist entries (the
 * highest-priority wishlist class — a registry-level hole needs no affected
 * profile to matter).
 */
export function matrixWishlistEntries(structuralMatrix) {
  const cells = Array.isArray(structuralMatrix?.uncovered_critical_cells)
    ? structuralMatrix.uncovered_critical_cells
    : []
  return cells.map(({ need, state }) => ({
    lane: STRUCTURAL_MATRIX_LANE,
    gap_class: GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL,
    detail: `${need}×${state}`,
    statement: `Registry coverage matrix: critical need '${need}' × ${state} has NO dedicated source — a ${state} profile with this need is structurally uncrawlable (the ECF-gap class).`,
    affected_profiles_count: 0,
    suggested_action: `Add a source covering '${need}' for ${state} (a national fallback lane preferred) to backend/crawler-os/sourceRegistry.js.`,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (system_kv; UPDATE-then-INSERT — shim-safe, mirrors
// enforceInvariants.js and the other agent scoreboards)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function kvSet(db, key, obj, at) {
  await ensureKv(db)
  const now = at || new Date().toISOString()
  const value = JSON.stringify(obj)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

/** Read the persisted scoreboard (Sam check / Anya digest / admin). */
export async function readGapScoreboard(db) {
  if (!db?.prepare) return null
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/** True when the scoreboard is missing a timestamp or older than maxAgeMs. */
export function isScoreboardStale(scoreboard, { now = Date.now(), maxAgeMs = STALE_MS } = {}) {
  const t = Date.parse(scoreboard?.generated_at || '')
  if (!Number.isFinite(t)) return true
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  return nowMs - t > maxAgeMs
}

async function loadActiveProfileRows(db, cap) {
  const isPg = db?.dialect === 'postgres'
  const limitSql = isPg ? 'LIMIT $1' : 'LIMIT ?'
  // First choice: exclude Amy's synthetic profiles by provenance (created_by).
  try {
    return await db
      .prepare(
        `SELECT id, display_name FROM profiles
          WHERE (status = 'active' OR status IS NULL)
            AND (created_by IS NULL OR created_by <> '${AMY_ORIGIN_CREATED_BY}')
          ORDER BY created_at DESC ${limitSql}`,
      )
      .all(cap)
  } catch {
    // Older schema without created_by — fall back to the plain scan (the
    // display-name filter below still keeps synthetics out).
    try {
      return await db
        .prepare(
          `SELECT id, display_name FROM profiles
            WHERE (status = 'active' OR status IS NULL)
            ORDER BY created_at DESC ${limitSql}`,
        )
        .all(cap)
    } catch {
      return []
    }
  }
}

/**
 * Build the fleet gap scoreboard and persist it to system_kv.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.limit=100]           max active profiles to scan (bounded ≤ 500)
 * @param {Function} [opts.buildEvidence]     injectable (db, profileId) → coverage evidence
 * @param {Function} [opts.buildMatrixSection] injectable () → structural_matrix section
 * @param {Date} [opts.now]
 * @param {boolean} [opts.persist=true]
 * @returns {Promise<object>} the scoreboard
 */
export async function buildFleetGapScoreboard(db, {
  limit = DEFAULT_SCAN_LIMIT,
  buildEvidence = buildCoverageEvidence,
  buildMatrixSection = buildStructuralMatrixSection,
  now = new Date(),
  persist = true,
} = {}) {
  if (!db?.prepare) throw new Error('buildFleetGapScoreboard: db required')
  const cap = Math.max(1, Math.min(MAX_SCAN_LIMIT, Number(limit) || DEFAULT_SCAN_LIMIT))

  const rows = await loadActiveProfileRows(db, cap)
  const results = []
  let scanned = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.display_name || '').startsWith(AMY_SYNTHETIC_NAME_PREFIX)) continue
    let evidence
    try {
      evidence = await buildEvidence(db, row.id)
    } catch (err) {
      log.warn('coverage evidence failed for profile', { profile_id: row.id, error: err?.message })
      continue
    }
    if (!evidence || evidence.error) continue
    scanned += 1
    results.push({
      profile_id: row.id,
      gaps: evidence.gaps,
      lanes: evidence.lanes,
      answer_next: evidence.answer_next,
    })
  }

  const body = aggregateGapResults(results)

  // Fleet-independent structural matrix: registry-level need×state holes join
  // the scoreboard even when NO live profile has hit them yet. Uncovered
  // CRITICAL cells become the highest-priority adapter-wishlist entries
  // (prepended ahead of the profile-derived ones, same WISHLIST_CAP).
  let structural_matrix = null
  try {
    structural_matrix = buildMatrixSection()
    const matrixEntries = matrixWishlistEntries(structural_matrix)
    if (matrixEntries.length) {
      body.adapter_wishlist = [...matrixEntries, ...body.adapter_wishlist].slice(0, WISHLIST_CAP)
    }
  } catch (err) {
    log.warn('structural matrix section failed (scoreboard still built)', { error: err?.message })
  }

  const scoreboard = {
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    scan_limit: cap,
    profiles_scanned: scanned,
    structural_matrix,
    ...body,
  }

  if (persist) {
    try {
      await kvSet(db, KV_KEY, scoreboard, scoreboard.generated_at)
    } catch (err) {
      log.warn('gap scoreboard persist failed (scoreboard still returned)', { error: err?.message })
    }
  }
  return scoreboard
}

// ─────────────────────────────────────────────────────────────────────────────
// Amy consumption — actions + archetype weighting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE: split the scoreboard's gaps into what Amy's OWN levers can act on vs
 * the structural adapter wishlist only a code change can fix.
 *
 *   actionable — lane_excluded / need_uncovered / disease_source_not_selected:
 *                Amy trains gap-weighted synthetic cohorts on these classes so
 *                her existing validated levers fire with evidence (additive
 *                source-coverage overrides via crawlerCoverageEditor, learned
 *                query steering via archetypeLearning).
 *   structural — no adapter exists (lane / state / disease): Amy cannot write
 *                code; these are surfaced as the prioritized adapter wishlist
 *                (top N by affected-profile count) for the owner/devs.
 */
export function deriveAmyGapActions(scoreboard) {
  const gaps = Array.isArray(scoreboard?.gaps) ? scoreboard.gaps : []
  const actionable = []
  const structural = []
  // Registry-level matrix holes lead the wishlist: they need no affected
  // profile to matter, and only a sourceRegistry.js change can close them.
  for (const entry of matrixWishlistEntries(scoreboard?.structural_matrix)) {
    structural.push({
      ...entry,
      lever: 'adapter_wishlist',
      reason: 'Registry need×state coverage matrix hole — needs a code change (backend/crawler-os/sourceRegistry.js); Amy cannot add adapters.',
    })
  }
  for (const g of gaps) {
    const base = {
      lane: g.lane,
      gap_class: g.gap_class,
      detail: g.detail,
      statement: g.statement,
      affected_profiles_count: g.count,
      suggested_action: g.suggested_action,
    }
    if (STRUCTURAL_GAP_CLASSES.has(g.gap_class)) {
      structural.push({
        ...base,
        lever: 'adapter_wishlist',
        reason: 'No source adapter exists — needs a code change (backend/crawler-os/sourceRegistry.js); Amy cannot add adapters.',
      })
    } else if (g.gap_class === GAP_CLASSES.NEED_UNCOVERED) {
      actionable.push({
        ...base,
        lever: 'additive_coverage',
        via: 'gap-weighted synthetic training → proposeCoverageOverrides (crawlerCoverageEditor; re-crawl validated, reversible)',
        enqueued: true,
      })
    } else if (g.gap_class === GAP_CLASSES.LANE_EXCLUDED || g.gap_class === GAP_CLASSES.DISEASE_NOT_SELECTED) {
      actionable.push({
        ...base,
        lever: 'weighted_training',
        via: 'gap-weighted archetype cohort → learned query steering (archetypeLearning) + coverage-override validation',
        enqueued: true,
      })
    }
    // GAP_CLASSES.OTHER carries no lever mapping — visible in the scoreboard,
    // never silently "actioned".
  }
  return { actionable, structural: structural.slice(0, WISHLIST_CAP) }
}

/**
 * Which synthetic-training categories exercise each coverage lane. Used to
 * WEIGHT Amy's archetype selection by the fleet's gap classes (owner
 * directive: tasks come from the gaps found in the crawls, not random).
 * Category ids come from backend/services/amy/syntheticProfileCatalog.js.
 */
export const LANE_CATEGORY_AFFINITY = Object.freeze({
  disease_specific: ['cancer_patient', 'chronic_illness_patient', 'disabled_person', 'senior_citizen', 'family_caregiver'],
  school_portals: ['high_school_student', 'college_student', 'graduate_student', 'homeschool_family', 'adult_learner'],
  federal_benefits: ['individual_assistance', 'veteran', 'military_family', 'single_parent', 'grandparent_caregiver', 'foster_youth', 'domestic_violence_survivor', 'disaster_survivor', 'senior_citizen', 'disabled_person'],
  state_programs: ['individual_assistance', 'business', 'nonprofit', 'college_student', 'senior_citizen'],
  county_city: ['nonprofit', 'community_development_corp', 'housing_authority', 'volunteer_fire_department', 'individual_assistance'],
  community_foundations: ['nonprofit', 'faith_based_org', 'community_development_corp'],
  private_charities: ['nonprofit', 'cancer_patient', 'individual_assistance', 'foster_youth'],
  local_211: ['individual_assistance', 'single_parent', 'domestic_violence_survivor', 'disaster_survivor', 'senior_citizen'],
  federal_grants: ['nonprofit', 'business', 'school_district', 'college_university', 'research_lab', 'workforce_org', 'volunteer_fire_department', 'housing_authority', 'tribal_org', 'rural_health_clinic'],
})

/** Weight bounds: 1 (no gap pressure) … 4 (lane gaps hit most of the fleet). */
export const MAX_CATEGORY_WEIGHT = 4

/**
 * PURE: derive per-category training weights from the scoreboard. A category
 * gains weight proportionally to the share of scanned profiles affected by
 * gaps on lanes it exercises; categories with no gap pressure stay at 1 so
 * baseline breadth training never stops.
 *
 * @param {object} scoreboard  from buildFleetGapScoreboard
 * @param {string[]} categoryIds  the categories Amy is training this run
 * @returns {Record<string, number>} category → integer weight in [1..MAX_CATEGORY_WEIGHT]
 */
export function weightCategoriesByGaps(scoreboard, categoryIds = []) {
  const ids = Array.isArray(categoryIds) ? categoryIds : []
  const pressure = {}
  for (const c of ids) pressure[c] = 0
  const scanned = Math.max(1, Number(scoreboard?.profiles_scanned) || 0)
  for (const g of Array.isArray(scoreboard?.gaps) ? scoreboard.gaps : []) {
    const affinities = g?.lane ? LANE_CATEGORY_AFFINITY[g.lane] : null
    if (!Array.isArray(affinities)) continue
    const share = Math.min(1, (Number(g.count) || 0) / scanned)
    for (const c of affinities) {
      if (c in pressure) pressure[c] += share
    }
  }
  const weights = {}
  for (const c of ids) {
    weights[c] = 1 + Math.min(MAX_CATEGORY_WEIGHT - 1, Math.round(3 * Math.min(1, pressure[c])))
  }
  return weights
}

export default {
  KV_KEY,
  STALE_MS,
  GAP_CLASSES,
  STRUCTURAL_GAP_CLASSES,
  STRUCTURAL_MATRIX_LANE,
  LANE_CATEGORY_AFFINITY,
  MAX_CATEGORY_WEIGHT,
  classifyGap,
  aggregateGapResults,
  buildStructuralMatrixSection,
  matrixWishlistEntries,
  buildFleetGapScoreboard,
  readGapScoreboard,
  isScoreboardStale,
  deriveAmyGapActions,
  weightCategoriesByGaps,
}
