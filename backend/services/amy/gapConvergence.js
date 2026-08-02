/**
 * gapConvergence.js — "no gaps left" vs "we stopped looking".
 *
 * The owner's goal is that Amy runs "until her profiles no longer reveal gaps".
 * The failure mode of that goal is the one he named himself: a gap count that
 * falls because the probing narrowed. A raw count cannot tell the two apart,
 * and neither can a rate, because both shrink when you ask fewer questions.
 *
 * THE RULE THIS MODULE ENFORCES
 * -----------------------------
 * Convergence may be claimed only when BOTH move the right way:
 *
 *   gaps        ↓   the count of gap findings per profile probed
 *   breadth     ↑   distinct probe-space PAIRS covered (probeCoverageLedger)
 *
 * Any other combination gets an explicit, unflattering name:
 *
 *   gaps ↓ , breadth ↓ or flat  →  NARROWED       ("we stopped looking")
 *   gaps ↑ , breadth ↑          →  EXPLORING      (new space, new holes — good)
 *   gaps ↑ , breadth ↓          →  REGRESSING
 *   gaps flat, breadth ↑        →  HOLDING
 *   not enough history          →  INSUFFICIENT_HISTORY
 *
 * AND A CLASS THAT NO LEVER CAN CLOSE IS NAMED. `findingActorRegistry` declares
 * an actor for every finding class; `approvalLedger.LEVER_REGISTRY` declares
 * whether that actor is AUTO, an owner surface, or a code change. A class whose
 * actor is a CODE_CHANGE and which has been reproducing for `staleNights()` is
 * a class the loop provably cannot close on its own — it is reported with the
 * file and the human action, rather than counted forever among "open gaps".
 *
 * MEASURED INPUT. The gap history is prod's own `system_kv amy_flywheel_cohort`
 * (21 retained ET days on 2026-08-02), which already records per-day
 * `clean` / `issues` / `finding_types`. This module reads it rather than
 * inventing a second scoreboard, so the trend it reports is the trend the
 * owner's email already shows.
 *
 * Pure: history + coverage + queue in, a verdict out. No I/O, no clock.
 */

import { actorFor } from './findingActorRegistry.js'
import { ACTIONABILITY, leverActionability, staleNights } from './approvalLedger.js'

export const TREND = Object.freeze({
  CONVERGING: 'converging',
  NARROWED: 'narrowed',
  EXPLORING: 'exploring',
  REGRESSING: 'regressing',
  HOLDING: 'holding',
  INSUFFICIENT_HISTORY: 'insufficient_history',
})

/** How many recent ET days each side of the comparison uses. */
export const WINDOW_DAYS = 5

function windowStats(days = []) {
  let issues = 0
  let profiles = 0
  for (const d of days) {
    issues += Number(d?.issues) || 0
    profiles += (Number(d?.clean) || 0) + (Number(d?.issues) || 0)
  }
  return {
    days: days.length,
    issues,
    profiles,
    gaps_per_profile: profiles > 0 ? Number((issues / profiles).toFixed(4)) : null,
  }
}

/**
 * Compare the last `WINDOW_DAYS` against the `WINDOW_DAYS` before them, on BOTH
 * axes, and refuse to call it convergence unless breadth rose.
 *
 * @param {object} args
 * @param {object} args.flywheel  `system_kv amy_flywheel_cohort` value
 * @param {object} args.coverage  `summarizeCoverage()` from probeCoverageLedger
 * @param {Array<object>} args.approvalQueue  this run's decorated queue
 * @returns {object}
 */
export function assessConvergence({ flywheel = null, coverage = null, approvalQueue = [] } = {}) {
  const dayMap = flywheel?.days && typeof flywheel.days === 'object' ? flywheel.days : {}
  const keys = Object.keys(dayMap).sort()
  const recent = keys.slice(-WINDOW_DAYS).map((k) => dayMap[k])
  const prior = keys.slice(-2 * WINDOW_DAYS, -WINDOW_DAYS).map((k) => dayMap[k])

  const now = windowStats(recent)
  const then = windowStats(prior)

  const breadthCovered = Number(coverage?.pairs_covered)
  const breadthDelta = Number(coverage?.pairs_covered_delta)
  // A ledger that has never been written has no breadth signal at all — that is
  // UNKNOWN, and unknown must never be read as "breadth rose".
  const breadthKnown = Number.isFinite(breadthCovered) && Number.isFinite(breadthDelta)
  const breadthRising = breadthKnown && breadthDelta > 0

  let trend = TREND.INSUFFICIENT_HISTORY
  let statement = 'Not enough retained history to compare two windows.'
  if (now.days >= 2 && then.days >= 2 && now.gaps_per_profile !== null && then.gaps_per_profile !== null) {
    const fell = now.gaps_per_profile < then.gaps_per_profile
    const rose = now.gaps_per_profile > then.gaps_per_profile
    if (fell && breadthRising) {
      trend = TREND.CONVERGING
      statement = `Gaps per profile fell ${then.gaps_per_profile} → ${now.gaps_per_profile} WHILE probe breadth rose by ${breadthDelta} pairs — fewer holes on MORE of the space.`
    } else if (fell) {
      trend = TREND.NARROWED
      statement = `Gaps per profile fell ${then.gaps_per_profile} → ${now.gaps_per_profile} but probe breadth did NOT rise (${breadthKnown ? `${breadthDelta} new pairs` : 'no coverage ledger'}). This is NOT convergence — the same or a narrower set of questions was asked.`
    } else if (rose && breadthRising) {
      trend = TREND.EXPLORING
      statement = `Gaps per profile rose ${then.gaps_per_profile} → ${now.gaps_per_profile} while breadth rose by ${breadthDelta} pairs — new space is being probed and it is finding holes. Expected while coverage is still opening up.`
    } else if (rose) {
      trend = TREND.REGRESSING
      statement = `Gaps per profile rose ${then.gaps_per_profile} → ${now.gaps_per_profile} without new breadth — the same questions started failing.`
    } else {
      trend = breadthRising ? TREND.HOLDING : TREND.NARROWED
      statement = breadthRising
        ? `Gaps per profile flat at ${now.gaps_per_profile} while breadth rose by ${breadthDelta} pairs — holding steady on a widening space.`
        : `Gaps per profile flat at ${now.gaps_per_profile} and breadth did not rise — nothing new was asked.`
    }
  }

  const unclosable = namedUnclosableClasses(approvalQueue)

  return {
    trend,
    statement,
    window_days: WINDOW_DAYS,
    recent: now,
    prior: then,
    breadth: breadthKnown
      ? {
          pairs_covered: breadthCovered,
          pairs_total: Number(coverage?.pairs_total) || null,
          pairs_covered_pct: Number(coverage?.pairs_covered_pct) || 0,
          new_pairs_this_run: breadthDelta,
          // The horizon, stated plainly rather than implied: at this run's rate,
          // how many more nights until the pair space is exhausted. `null` when
          // the run added nothing (no rate to extrapolate from).
          nights_to_full_coverage:
            breadthDelta > 0 && Number.isFinite(Number(coverage?.pairs_total))
              ? Math.ceil((Number(coverage.pairs_total) - breadthCovered) / breadthDelta)
              : null,
        }
      : null,
    // The honest "we cannot finish this" list.
    unclosable_by_any_lever: unclosable,
    goal_reachable: unclosable.length === 0,
  }
}

/**
 * Gap classes the loop CANNOT close by itself, with what a human must do.
 *
 * An item is listed when its lever's actionability is CODE_CHANGE and it has
 * been open at least the stale bar. AUTO items are Amy's own work and OWNER_API
 * items have a click; neither belongs on a "no lever can close this" list, and
 * putting them there would be the same fake ask #1085 removed.
 */
export function namedUnclosableClasses(approvalQueue = []) {
  const out = []
  for (const item of Array.isArray(approvalQueue) ? approvalQueue : []) {
    const meta = leverActionability(item?.lever)
    if (meta.actionability !== ACTIONABILITY.CODE_CHANGE) continue
    const nights = Number(item?.nights_open) || 0
    if (nights < staleNights()) continue
    const actor = actorFor(item?.finding_type)
    out.push({
      finding_type: item?.finding_type ?? null,
      category: item?.category ?? null,
      lever: item?.lever ?? null,
      nights_open: nights,
      file: item?.target_file ?? item?.code_brief?.file ?? null,
      human_action: meta.why || actor?.note || 'A code change is required; no data-only knob exists.',
    })
  }
  return out.sort((a, b) => b.nights_open - a.nights_open)
}

export default { TREND, WINDOW_DAYS, assessConvergence, namedUnclosableClasses }
