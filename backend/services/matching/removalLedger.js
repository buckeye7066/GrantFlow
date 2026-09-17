/**
 * removalLedger.js — bounded, aggregate accounting of WHY evaluated
 * candidates were not shown to a profile.
 *
 * canonical_rules G2: zero results is a failure state, and a discovery
 * operation that evaluates candidates but shows none must log why items were
 * removed before it relaxes or re-scores. The existing surfaces reported only
 * survivor counts per tier; this module gives every discovery selector one
 * ledger shape whose buckets reconcile against the loaded count, so a silent
 * drop is an arithmetic error the tests catch rather than a mystery.
 *
 * Aggregate-only by design: reason → count. Never row identities, never
 * profile facts.
 */
import { displayRefusal } from '../../config/matchSurfacing.js'

function sumCounts(counts) {
  if (!counts || typeof counts !== 'object') return 0
  return Object.values(counts).reduce((total, value) => total + (Number(value) || 0), 0)
}

function nonNegativeInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/**
 * Count display-gate refusals by reason across rows that survived the
 * canonical funnel. Rows that qualify contribute nothing.
 * @param {Array<object>} rows
 * @param {number} minScore
 * @returns {Record<string, number>}
 */
export function tallyDisplayRefusals(rows, minScore) {
  const tally = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    const refusal = displayRefusal(row, minScore)
    if (!refusal) continue
    tally[refusal.reason] = (tally[refusal.reason] || 0) + 1
  }
  return tally
}

/**
 * Build the ledger for one selection pass.
 *
 * Reconciliation identity (every loaded row lands in exactly one bucket, and a
 * G2 recovery pass may re-admit rows that an earlier bucket already counted):
 *
 *   loaded = returned
 *          + Σ canonical + filter + Σ display
 *          + truth_boundary + dedupe + pipeline_excluded
 *          − recovery.readmitted
 *
 * @param {object} input
 * @param {number} input.loaded            rows read from the match store
 * @param {Record<string,number>} [input.canonicalDropped]  canonical funnel drops by reason
 * @param {number} [input.filterRemoved]   caller filters (search terms, state, award range)
 * @param {Record<string,number>} [input.displayRefused]    display-gate refusals by reason
 * @param {{tier?: string|null, readmitted: number}|null} [input.recovery]
 * @param {number} [input.truthBoundaryRemoved]
 * @param {number} [input.dedupeRemoved]
 * @param {number} [input.pipelineExcluded]
 * @param {number} input.returned
 */
export function buildRemovalLedger({
  loaded,
  canonicalDropped = {},
  filterRemoved = 0,
  displayRefused = {},
  recovery = null,
  truthBoundaryRemoved = 0,
  dedupeRemoved = 0,
  pipelineExcluded = 0,
  returned,
} = {}) {
  const loadedCount = nonNegativeInt(loaded)
  const returnedCount = nonNegativeInt(returned)
  const canonical = { ...(canonicalDropped || {}) }
  const display = { ...(displayRefused || {}) }
  const readmitted = recovery ? nonNegativeInt(recovery.readmitted) : 0
  const removed = {
    canonical,
    filter: nonNegativeInt(filterRemoved),
    display,
    truth_boundary: nonNegativeInt(truthBoundaryRemoved),
    dedupe: nonNegativeInt(dedupeRemoved),
    pipeline_excluded: nonNegativeInt(pipelineExcluded),
  }
  const removedTotal =
    sumCounts(canonical) + removed.filter + sumCounts(display) +
    removed.truth_boundary + removed.dedupe + removed.pipeline_excluded
  const unaccounted = loadedCount - returnedCount - removedTotal + readmitted
  return {
    loaded: loadedCount,
    returned: returnedCount,
    removed,
    removed_total: removedTotal,
    recovery: recovery ? { tier: recovery.tier ?? null, readmitted } : null,
    reconciles: unaccounted === 0,
    unaccounted,
  }
}

export default { tallyDisplayRefusals, buildRemovalLedger }
