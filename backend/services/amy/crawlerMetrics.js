/**
 * crawlerMetrics.js
 *
 * Turns Amy's per-profile evaluations into COHORT-level crawler-quality metrics
 * and supports sweeping the match score floor across the whole cohort WITHOUT
 * re-crawling. The floor is applied AFTER scoring, so given each profile's
 * retained scored candidates we can compute exactly what coverage / precision
 * the crawler WOULD have at any candidate floor — and pick the best.
 *
 * This is the measurement substrate that makes "improve the crawlers" provable:
 * every tuning change is judged by whether it raises the cohort quality score.
 */

import { ACCEPT_SCORE } from '../../config/matchThresholds.js'

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Compute crawler outcomes for ONE evaluation at a given score floor, using its
 * retained `candidates` (each { score, topical, decision, generic }).
 *
 * `scoreKey` selects which retained candidate field the floor is applied to:
 *   - 'score'   (default) — the FINAL match score (data-point scale,
 *     2026-07-06). Right lens for floor sweeps and coverage validation
 *     (the floor gates final scores).
 *   - 'topical' — the legacy weighted-evidence subscale
 *     (scoreBreakdown.topical_evidence). Right lens for WEIGHT-tuning
 *     validation: since the 2026-07 scale changes (need-anchored, then
 *     data-point) the final score no longer moves with W_* weight changes —
 *     weights act only inside the topical blend.
 * Candidates missing the requested field fall back to `score`.
 *
 * @returns {{ qualified, accepted, falsePositives, covered }}
 */
export function profileOutcomeAtFloor(evaluation, floor, { scoreKey = 'score' } = {}) {
  const candidates = Array.isArray(evaluation?.candidates) ? evaluation.candidates : []
  const qualified = candidates.filter((c) => num(c?.[scoreKey] ?? c?.score) >= floor)
  // A "real" qualified match = qualified AND not a generic/directory false-positive.
  const real = qualified.filter((c) => !c.generic)
  const falsePositives = qualified.filter((c) => c.generic)
  return {
    qualified: qualified.length,
    accepted: real.length,
    falsePositives: falsePositives.length,
    covered: real.length > 0,
  }
}

/**
 * Cohort metrics at a given floor. Higher quality = more covered profiles with
 * fewer false positives.
 *
 * quality_score = covered_rate - FALSE_POSITIVE_PENALTY * false_positive_rate
 *
 * where false_positive_rate is the share of profiles whose qualified set is
 * contaminated by a generic/directory false positive.
 */
export const FALSE_POSITIVE_PENALTY = 0.6

export function cohortMetricsAtFloor(evaluations, floor, { scoreKey = 'score' } = {}) {
  const evals = Array.isArray(evaluations) ? evaluations : []
  // Only profiles that actually produced scored candidates are scoreable; a
  // profile that was skipped/errored is tracked separately (it's a crawler
  // failure, not a threshold question).
  const scoreable = evals.filter((e) => Array.isArray(e?.candidates))
  const n = scoreable.length || 0

  let covered = 0
  let fpProfiles = 0
  let totalQualified = 0
  let totalFalsePositives = 0
  for (const e of scoreable) {
    const o = profileOutcomeAtFloor(e, floor, { scoreKey })
    if (o.covered) covered += 1
    if (o.falsePositives > 0) fpProfiles += 1
    totalQualified += o.qualified
    totalFalsePositives += o.falsePositives
  }

  const coveredRate = n > 0 ? covered / n : 0
  const falsePositiveRate = n > 0 ? fpProfiles / n : 0
  const qualityScore = Number((coveredRate - FALSE_POSITIVE_PENALTY * falsePositiveRate).toFixed(4))

  return {
    floor,
    scoreable_profiles: n,
    covered,
    covered_rate: Number(coveredRate.toFixed(4)),
    zero_rate: Number((n > 0 ? 1 - coveredRate : 0).toFixed(4)),
    false_positive_profiles: fpProfiles,
    false_positive_rate: Number(falsePositiveRate.toFixed(4)),
    total_qualified: totalQualified,
    total_false_positives: totalFalsePositives,
    quality_score: qualityScore,
  }
}

/**
 * Sweep a range of floors and return per-floor metrics plus the best floor by
 * quality_score (tie-break: higher floor → more precision).
 *
 * @param {Array<object>} evaluations
 * @param {object} [opts] { min=50, max=90, step=5 }
 * @returns {{ sweep: object[], best: object }}
 */
export function sweepFloors(evaluations, { min = 50, max = 90, step = 5 } = {}) {
  const sweep = []
  for (let f = min; f <= max; f += step) {
    sweep.push(cohortMetricsAtFloor(evaluations, f))
  }
  let best = sweep[0]
  for (const m of sweep) {
    if (
      m.quality_score > best.quality_score ||
      (m.quality_score === best.quality_score && m.floor > best.floor)
    ) {
      best = m
    }
  }
  return { sweep, best }
}

/**
 * Headline cohort summary at the CURRENT operating floor, plus crawler-failure
 * rates that are independent of the threshold (skip/error/source failures).
 */
export function summarizeCohort(evaluations, currentFloor = ACCEPT_SCORE) {
  const evals = Array.isArray(evaluations) ? evaluations : []
  const total = evals.length
  const at = cohortMetricsAtFloor(evals, currentFloor)
  return {
    profiles: total,
    current_floor: currentFloor,
    covered_rate: at.covered_rate,
    zero_rate: at.zero_rate,
    false_positive_rate: at.false_positive_rate,
    quality_score: at.quality_score,
    skipped: evals.filter((e) => e.status === 'skipped').length,
    errored: evals.filter((e) => e.status === 'error').length,
    source_failure_profiles: evals.filter((e) => num(e.sources_failed) > 0).length,
    weak: evals.filter((e) => e.status === 'weak').length,
    zero: evals.filter((e) => e.status === 'zero').length,
    ok: evals.filter((e) => e.status === 'ok').length,
  }
}

export default { profileOutcomeAtFloor, cohortMetricsAtFloor, sweepFloors, summarizeCohort, FALSE_POSITIVE_PENALTY }
