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
import { leverActionability, ACTIONABILITY } from './approvalLedger.js'

/**
 * @param {object} args
 * @param {number} args.currentFloor
 * @param {object} args.best        - best floor metrics from sweepFloors()
 * @param {object} args.currentMetrics - cohort metrics at currentFloor
 * @param {object} [args.opts] { minCohort=12, maxDelta=10, minGain=0.03,
 *        bounds=[DISCOVERY_MIN_SCORE_FLOOR,85] }. SAFETY: the lower bound is
 *        HARD-clamped to DISCOVERY_MIN_SCORE_FLOOR (8 on the 2026-07-06
 *        data-point scale — see backend/config/matchThresholds.js) — no
 *        caller-supplied bounds can let a tuning proposal drop the display
 *        floor below the documented product standard. Coverage must come from
 *        better queries/sources, never from loosening the bar.
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
  // 2026-07-06: was ABSENT — CDC zero-result gaps could never auto-remediate
  // and every finding for the category dead-ended in the approval queue.
  community_development_corp: { applicant_types: ['nonprofit'], need_categories: ['housing_development', 'economic_development'], source: 'eda_economic_development' },
  // 2026-08-01: both categories produced a LOCATOR-ONLY crawl in prod (stored
  // 178/190, zero direct awards recommended) and had no coverage lane at all,
  // so every finding for them dead-ended in the approval queue against a lever
  // that cannot move the final score. See the locator-only routing below.
  housing_authority: { applicant_types: ['government', 'nonprofit'], need_categories: ['housing', 'housing_development'], source: 'hud_homeless_assistance' },
  tribal_org: { applicant_types: ['government', 'nonprofit'], need_categories: ['programs', 'housing', 'economic_development'], source: 'bia_tribal_programs' },
})

/**
 * A weak evaluation whose ENTIRE recommendation list is DIRECTORY locators.
 *
 * `isRecommendable` admits an ACCEPT of any kind plus a DIRECTORY locator at
 * REVIEW, and the canonical locator rule forbids a locator from ever claiming
 * ACCEPT — so "stored a lot, recommended only locators" is a DIRECT-AWARD
 * COVERAGE gap. Routing it at `scoring_weights` was unclosable by construction:
 * W_* weights move only the topical-evidence subscale, never the final score.
 *
 * Older evaluations (before the split shipped) carry no `locator_only` field;
 * they are treated as NOT locator-only so the historical routing is unchanged.
 */
function isLocatorOnlyWeak(evaluation) {
  return evaluation?.status === 'weak' && evaluation?.locator_only === true
}

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
  // A LOCATOR-ONLY crawl is a stronger signal than a zero result at the same
  // sample size: the run reached the open web, stored 170+ rows, and still
  // recommended nothing but pointers — that is not a search outage, it is a
  // missing direct-award lane. It also cannot be closed any other way (the
  // `scoring_weights` lever provably does not move the final score). Every
  // proposal here is still additive-only, empirically re-crawl validated,
  // auto-reverted on no gain, and gated by AMY_APPLY_COVERAGE.
  const minLocatorOnly = Number.isFinite(opts.minLocatorOnly) ? opts.minLocatorOnly : 1
  const evals = Array.isArray(evaluations) ? evaluations : []
  const zeroByCat = tally(evals.filter((e) => e.status === 'zero'), (e) => e.category)
  const locatorOnlyByCat = tally(evals.filter(isLocatorOnlyWeak), (e) => e.category)
  const gapByCat = { ...zeroByCat }
  for (const [category, count] of Object.entries(locatorOnlyByCat)) {
    if (count < minLocatorOnly) continue
    gapByCat[category] = Math.max(Number(gapByCat[category]) || 0, minZero)
  }
  const next = JSON.parse(JSON.stringify(liveOverrides || {}))
  const additions = []

  for (const [category, count] of Object.entries(gapByCat)) {
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
      additions.push({
        source_id: sid,
        category,
        zero_profiles: Number(zeroByCat[category]) || 0,
        locator_only_profiles: Number(locatorOnlyByCat[category]) || 0,
        gap_kind: (Number(zeroByCat[category]) || 0) >= minZero ? 'zero_result' : 'locator_only',
        ...cov,
      })
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
      rationale: `${count} "${category}" profile(s) had generic results ACCEPTED as strong matches. Approve the relevance_precision lever (Amy console → "relevance") to add the recurring generic phrasing to the shared vocabulary so those titles are held at REVIEW instead of clearing ACCEPT.`,
      evidence: { false_positive_profiles: count },
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
    })
  }

  // 3. Weak categories. SPLIT BY WHAT ACTUALLY WENT WRONG (2026-08-01).
  //
  //  (a) LOCATOR-ONLY — the run recommended nothing but DIRECTORY pointers,
  //      which the locator rule forbids from ever claiming ACCEPT. Routing this
  //      at `scoring_weights` asked the owner to approve a lever that provably
  //      cannot move the final score (weights act only inside the topical
  //      subscale), so the item could never be closed. It is a DIRECT-AWARD
  //      coverage gap and goes to the coverage lever, which Amy can apply
  //      herself under re-crawl validation + auto-revert.
  //  (b) genuinely weak DIRECT awards — real scoring under-credit, unchanged.
  const locatorOnlyByCat = tally(evals.filter(isLocatorOnlyWeak), (e) => e.category)
  const directWeakByCat = tally(
    evals.filter((e) => e.status === 'weak' && !isLocatorOnlyWeak(e)),
    (e) => e.category,
  )
  for (const [category, count] of Object.entries(locatorOnlyByCat)) {
    const covered = Boolean(CATEGORY_COVERAGE[category])
    items.push({
      id: `coverage_direct:${category}`,
      lever: 'source_keyword_coverage',
      target_file: CODE_TARGETS[FINDING_TYPES.ZERO_RESULT].file,
      category,
      severity: SEVERITY.HIGH,
      rationale: `${count} "${category}" profile(s) stored real candidates but recommended ONLY DIRECTORY locators — pointers, which by the locator rule can never claim ACCEPT. This is a direct-award coverage gap for the category, not a scoring gap${covered ? ' (Amy can widen the mapped source lane herself and re-crawl to validate)' : ' — and the category has NO entry in CATEGORY_COVERAGE, so no source lane can be widened for it yet'}.`,
      evidence: { locator_only_profiles: count, has_coverage_lane: covered },
    })
  }
  for (const [category, count] of Object.entries(directWeakByCat)) {
    items.push({
      id: `scoring:${category}`,
      lever: 'scoring_weights',
      target_file: CODE_TARGETS[FINDING_TYPES.WEAK_MATCH].file,
      category,
      severity: SEVERITY.MEDIUM,
      rationale: `${count} "${category}" profile(s) recommended direct awards but none scored strongly. Review need/eligibility/category credit for this applicant type.`,
      evidence: { weak_profiles: count },
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
    })
  }

  // ── ACTIONABILITY (2026-08-01) ──────────────────────────────────────────
  // Every item declares HOW it can be closed, from the single LEVER_REGISTRY.
  // `requires_approval` must mean "a human CAN approve this", never "a human is
  // being asked to": items on an AUTO lever are Amy's own work, and items on a
  // CODE_CHANGE lever cannot be closed by any approval at all. Rendering those
  // as "Needs your approval" is the fake ask that made this queue unreadable —
  // six lines in the owner's morning email, none of them clickable, none of
  // them ever actioned in production.
  for (const item of items) {
    const meta = leverActionability(item.lever)
    item.actionability = meta.actionability
    item.apply_surface = meta.surface
    item.human_gate_reason = meta.why
    item.requires_approval = meta.actionability === ACTIONABILITY.OWNER_API
  }

  // Order by severity then evidence size.
  const sevRank = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))
  return items
}

export default {
  decideFloorChange,
  decideWeightChange,
  proposeCoverageOverrides,
  buildApprovalQueue,
}
