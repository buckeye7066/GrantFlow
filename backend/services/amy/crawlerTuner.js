/**
 * crawlerTuner.js
 *
 * The "improve the crawlers" brain. Two responsibilities, both pure:
 *
 *  1. decideFloorChange() — given the floor sweep over the synthetic cohort,
 *     decide whether to move DEFAULT_MIN_SCORE, bounded and conservative, only
 *     when the cohort is big enough and the gain clears a margin. The chosen
 *     floor's metrics ARE the projected "after" (computed on the same cohort),
 *     so the improvement is proven before we touch the file.
 *
 *  2. buildApprovalQueue() — aggregate the deeper crawler weaknesses (zero
 *     results per category, false positives, weak scoring, source failures,
 *     field-mapping gaps) into concrete, human-approvable improvement proposals
 *     pointed at real files. These are the changes too risky to auto-apply.
 */

import { DISCOVERY_MIN_SCORE_FLOOR } from '../../config/matchThresholds.js'
import { FINDING_TYPES, CODE_TARGETS, SEVERITY } from './amyConstants.js'

/**
 * @param {object} args
 * @param {number} args.currentFloor
 * @param {object} args.best        - best floor metrics from sweepFloors()
 * @param {object} args.currentMetrics - cohort metrics at currentFloor
 * @param {object} [args.opts] { minCohort=12, maxDelta=10, minGain=0.03,
 *        bounds=[DISCOVERY_MIN_SCORE_FLOOR,85] }. SAFETY: the lower bound is
 *        HARD-clamped to DISCOVERY_MIN_SCORE_FLOOR (75) — no caller-supplied
 *        bounds can let a tuning proposal drop the display floor below the
 *        documented product standard. Coverage must come from better
 *        queries/sources, never from loosening the bar.
 * @returns {{ change:boolean, from:number, to:number, reason:string, projected:object, gain:number }}
 */
export function decideFloorChange({ currentFloor, best, currentMetrics, opts = {} }) {
  const minCohort = Number.isFinite(opts.minCohort) ? opts.minCohort : 12
  const maxDelta = Number.isFinite(opts.maxDelta) ? opts.maxDelta : 10
  const minGain = Number.isFinite(opts.minGain) ? opts.minGain : 0.03
  const rawBounds = Array.isArray(opts.bounds) ? opts.bounds : [DISCOVERY_MIN_SCORE_FLOOR, 85]
  const bounds = [Math.max(DISCOVERY_MIN_SCORE_FLOOR, Number(rawBounds[0]) || DISCOVERY_MIN_SCORE_FLOOR), Number(rawBounds[1]) || 85]

  const projected = best
  const gain = Number(((best?.quality_score ?? 0) - (currentMetrics?.quality_score ?? 0)).toFixed(4))

  if (!best || !currentMetrics) {
    return { change: false, from: currentFloor, to: currentFloor, reason: 'no_metrics', projected, gain }
  }
  if ((currentMetrics.scoreable_profiles ?? 0) < minCohort) {
    return { change: false, from: currentFloor, to: currentFloor, reason: `cohort_too_small(<${minCohort})`, projected, gain }
  }
  if (best.floor === currentFloor) {
    return { change: false, from: currentFloor, to: currentFloor, reason: 'already_optimal', projected, gain }
  }
  if (gain < minGain) {
    return { change: false, from: currentFloor, to: currentFloor, reason: `gain_below_margin(${gain}<${minGain})`, projected, gain }
  }

  // Bound the move: at most maxDelta from current, clamped to [lo, hi].
  const [lo, hi] = bounds
  let to = best.floor
  if (to > currentFloor + maxDelta) to = currentFloor + maxDelta
  if (to < currentFloor - maxDelta) to = currentFloor - maxDelta
  to = Math.max(lo, Math.min(hi, to))
  if (to === currentFloor) {
    return { change: false, from: currentFloor, to: currentFloor, reason: 'bounded_to_current', projected, gain }
  }

  const direction = to > currentFloor ? 'raise' : 'lower'
  const why =
    direction === 'raise'
      ? `raising the floor ${currentFloor}→${to} cuts false positives (fp_rate ${currentMetrics.false_positive_rate}→${best.false_positive_rate})`
      : `lowering the floor ${currentFloor}→${to} lifts coverage (covered ${currentMetrics.covered_rate}→${best.covered_rate})`
  return { change: true, from: currentFloor, to, reason: why, projected, gain }
}

/**
 * Decide a bounded scoring-WEIGHT nudge from cohort symptoms. The direction is
 * a hypothesis — it is ALWAYS validated empirically by a re-crawl + auto-revert,
 * so we only need a sensible step:
 *   - high weak-rate, low false-positives  → under-crediting FIT: bump W_NEED + W_CATEGORY
 *   - high false-positive-rate              → under-crediting PRECISION: bump W_ELIGIBILITY
 *
 * @param {object} args { currentWeights, cohort, opts:{minCohort, step} }
 * @returns {{ change, from, to, reason }}
 */
export function decideWeightChange({ currentWeights, cohort, opts = {} }) {
  const minCohort = Number.isFinite(opts.minCohort) ? opts.minCohort : 12
  const step = Number.isFinite(opts.step) ? opts.step : 0.04
  const from = currentWeights || null
  if (!from) return { change: false, from, to: from, reason: 'no_weights' }
  if ((cohort?.profiles ?? 0) < minCohort) {
    return { change: false, from, to: from, reason: `cohort_too_small(<${minCohort})` }
  }

  const weakRate = (cohort.weak || 0) / Math.max(1, cohort.profiles)
  const fpRate = Number(cohort.false_positive_rate || 0)
  const to = { ...from }
  let reason = null

  if (fpRate >= 0.2) {
    to.W_ELIGIBILITY = (from.W_ELIGIBILITY || 0) + step
    to.W_CATEGORY = (from.W_CATEGORY || 0) - step
    reason = `false-positive rate ${fpRate}: shift weight toward eligibility/precision`
  } else if (weakRate >= 0.25) {
    to.W_NEED = (from.W_NEED || 0) + step
    to.W_GEO = (from.W_GEO || 0) - step
    reason = `weak-match rate ${weakRate.toFixed(2)}: shift weight toward need/fit`
  } else {
    return { change: false, from, to: from, reason: 'no_weight_symptom' }
  }
  return { change: true, from, to, reason }
}

/** Static map: Amy category → the registry coverage it implies. */
const CATEGORY_COVERAGE = Object.freeze({
  veteran: { applicant_types: ['veteran'], need_categories: ['veterans'], source: 'benefits_gov' },
  military_family: { applicant_types: ['military_spouse'], need_categories: ['military_spouse_support'], source: 'military_onesource' },
  disaster_survivor: { applicant_types: ['individual', 'family'], need_categories: ['emergency'], source: 'united_way_211' },
  foster_youth: { applicant_types: ['individual', 'student'], need_categories: ['education', 'housing'], source: 'united_way_211' },
  grandparent_caregiver: { applicant_types: ['individual', 'family'], need_categories: ['caregiving'], source: 'united_way_211' },
  single_parent: { applicant_types: ['individual', 'family'], need_categories: ['childcare', 'housing'], source: 'community_action' },
  domestic_violence_survivor: { applicant_types: ['individual', 'family'], need_categories: ['domestic_violence', 'housing'], source: 'united_way_211' },
  rural_health_clinic: { applicant_types: ['nonprofit', 'government'], need_categories: ['medical'], source: 'hrsa_health_centers' },
  agricultural_cooperative: { applicant_types: ['farm'], need_categories: ['agriculture', 'capital'], source: 'usda_rd' },
  research_lab: { applicant_types: ['business', 'nonprofit'], need_categories: ['programs', 'technology'], source: 'nih_guide' },
  workforce_org: { applicant_types: ['nonprofit', 'government'], need_categories: ['workforce', 'employment'], source: 'eda_economic_development' },
  // Archetype-breadth additions (2026-07-01) — coverage lanes for the synthetic
  // categories Amy now exercises, so a proven zero-result gap can auto-widen a
  // real, relevant source instead of only landing in the approval queue.
  senior_citizen: { applicant_types: ['senior', 'individual'], need_categories: ['aging', 'senior'], source: 'area_agency_on_aging' },
  family_caregiver: { applicant_types: ['caregiver', 'family'], need_categories: ['caregiving'], source: 'area_agency_on_aging' },
  first_responder: { applicant_types: ['individual'], need_categories: ['education', 'emergency'], source: 'united_way_211' },
  adult_learner: { applicant_types: ['student', 'individual'], need_categories: ['education'], source: 'studentaid_gov' },
  volunteer_fire_department: { applicant_types: ['vfd'], need_categories: ['equipment', 'emergency', 'operations'], source: 'fema_afg' },
})

/**
 * Propose ADDITIVE coverage overrides for categories that returned zero results
 * across multiple profiles AND map to a real registry source. Conservative:
 * only fires for a known category gap (>= minZero profiles).
 *
 * @param {Array<object>} evaluations
 * @param {object} args { liveOverrides, opts:{ minZero=2 } }
 * @returns {{ change, additions, next, reason }}
 */
export function proposeCoverageOverrides(evaluations = [], { liveOverrides = {}, opts = {} } = {}) {
  const minZero = Number.isFinite(opts.minZero) ? opts.minZero : 2
  const zeroByCat = tally((Array.isArray(evaluations) ? evaluations : []).filter((e) => e.status === 'zero'), (e) => e.category)
  const next = JSON.parse(JSON.stringify(liveOverrides || {}))
  const additions = []

  for (const [category, count] of Object.entries(zeroByCat)) {
    if (count < minZero) continue
    const cov = CATEGORY_COVERAGE[category]
    if (!cov) continue
    const sid = cov.source
    const entry = next[sid] || { add_need_categories: [], add_applicant_types: [] }
    const beforeN = new Set(entry.add_need_categories || [])
    const beforeT = new Set(entry.add_applicant_types || [])
    for (const n of cov.need_categories) beforeN.add(n)
    for (const t of cov.applicant_types) beforeT.add(t)
    const merged = { add_need_categories: [...beforeN], add_applicant_types: [...beforeT] }
    if (JSON.stringify(merged) !== JSON.stringify(next[sid] || {})) {
      next[sid] = merged
      additions.push({ source_id: sid, category, zero_profiles: count, ...cov })
    }
  }

  return { change: additions.length > 0, additions, next, reason: additions.length ? `coverage gaps for ${additions.map((a) => a.category).join(', ')}` : 'no_coverage_gap' }
}

function tally(arr, keyFn) {
  const out = {}
  for (const x of arr) {
    const k = keyFn(x)
    if (k === undefined || k === null) continue
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * Build the human-approval queue of deeper crawler improvements from the cohort
 * evaluations. These map systematic weaknesses to concrete files/levers.
 *
 * @param {Array<object>} evaluations
 * @returns {Array<object>} approval items
 */
export function buildApprovalQueue(evaluations = []) {
  const evals = Array.isArray(evaluations) ? evaluations : []
  const items = []

  // 1. Zero-result CATEGORIES → source/keyword coverage gap (planner/registry).
  const zeroByCat = tally(evals.filter((e) => e.status === 'zero'), (e) => e.category)
  for (const [category, count] of Object.entries(zeroByCat)) {
    items.push({
      id: `coverage:${category}`,
      lever: 'source_keyword_coverage',
      target_file: CODE_TARGETS[FINDING_TYPES.ZERO_RESULT].file,
      category,
      severity: SEVERITY.HIGH,
      rationale: `${count} synthetic "${category}" profile(s) returned ZERO opportunities — the planner is not selecting any source that covers this category. Add category→source/keyword coverage.`,
      evidence: { zero_profiles: count },
      requires_approval: true,
    })
  }

  // 2. False positives → relevance/scoring over-credit (matchEngine/relevance).
  const fpByCat = tally(evals.filter((e) => Number(e.false_positives) > 0), (e) => e.category)
  for (const [category, count] of Object.entries(fpByCat)) {
    items.push({
      id: `false_positive:${category}`,
      lever: 'relevance_precision',
      target_file: CODE_TARGETS[FINDING_TYPES.FALSE_POSITIVE].file,
      category,
      severity: SEVERITY.HIGH,
      rationale: `${count} "${category}" profile(s) had generic/directory results ACCEPTED as strong matches. Tighten relevance/scoring so generic results cannot clear ACCEPT for specific profiles.`,
      evidence: { false_positive_profiles: count },
      requires_approval: true,
    })
  }

  // 2b. Ineligible ACCEPTs → eligibility gate under-enforcing (matchEngine gate).
  // A profile-INELIGIBLE opportunity (enrolled-student aid for a non-student, an
  // applicant-type/geo-exclusive award) reached ACCEPT. The evolution goal is
  // fewer ineligible ACCEPTs at SCORING time — tighten the eligibility gate so
  // these can never clear ACCEPT for the wrong profile category.
  const ineligByCat = tally(evals.filter((e) => Number(e.ineligible_accepts) > 0), (e) => e.category)
  for (const [category, count] of Object.entries(ineligByCat)) {
    items.push({
      id: `ineligible_match:${category}`,
      lever: 'eligibility_gate',
      target_file: CODE_TARGETS[FINDING_TYPES.INELIGIBLE_MATCH].file,
      category,
      severity: SEVERITY.HIGH,
      rationale: `${count} "${category}" profile(s) ACCEPTED an opportunity they are INELIGIBLE for (e.g. enrolled-student aid for a non-student). Evolve the eligibility gate so ineligible opportunities REJECT/cap below the floor at scoring time; the surfacedEligibility sweep is only the net.`,
      evidence: { ineligible_profiles: count },
      requires_approval: true,
    })
  }

  // 3. Weak categories → scoring under-credit (matchEngine weights).
  const weakByCat = tally(evals.filter((e) => e.status === 'weak'), (e) => e.category)
  for (const [category, count] of Object.entries(weakByCat)) {
    items.push({
      id: `scoring:${category}`,
      lever: 'scoring_weights',
      target_file: CODE_TARGETS[FINDING_TYPES.WEAK_MATCH].file,
      category,
      severity: SEVERITY.MEDIUM,
      rationale: `${count} "${category}" profile(s) found opportunities but none scored strongly. Review need/eligibility/category credit for this applicant type.`,
      evidence: { weak_profiles: count },
      requires_approval: true,
    })
  }

  // 4. Source failures → adapter/source health (sourceRegistry/adapters).
  const failedSourceProfiles = evals.filter((e) => Number(e.sources_failed) > 0)
  if (failedSourceProfiles.length > 0) {
    items.push({
      id: 'source_health',
      lever: 'adapter_source_health',
      target_file: CODE_TARGETS[FINDING_TYPES.SOURCE_FETCH_FAILED].file,
      severity: SEVERITY.MEDIUM,
      rationale: `${failedSourceProfiles.length} profile(s) hit source fetch/parse failures. Audit adapter health, retries, and missing API keys.`,
      evidence: { profiles_with_source_failures: failedSourceProfiles.length },
      requires_approval: true,
    })
  }

  // Order by severity then evidence size.
  const sevRank = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))
  return items
}

export default { decideFloorChange, decideWeightChange, proposeCoverageOverrides, buildApprovalQueue }
