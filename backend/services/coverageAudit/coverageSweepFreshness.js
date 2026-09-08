/** Called only after acquiring the existing heartbeated coverage-sweep lock.
 * A 'running' marker is evidence of an attempt, never of completed coverage.
 * A restarted process may reclaim an expired lease and retry on its next tick
 * instead of skipping an interrupted run for the full 20-hour freshness window.
 */
export function isCoverageSweepDue(last, { nowMs = Date.now(), dueMs = 20 * 60 * 60 * 1000 } = {}) {
  if (!last || last.status !== 'completed' || last.ok !== true) return true
  const completedMs = Date.parse(last.recorded_at || last.updated_at || '')
  if (!Number.isFinite(completedMs) || completedMs > nowMs) return true
  return nowMs - completedMs >= dueMs
}
