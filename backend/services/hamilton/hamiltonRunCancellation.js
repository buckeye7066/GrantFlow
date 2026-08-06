/**
 * In-process cancellation for active Hamilton browser runs.
 *
 * The database task status remains the cross-process authority. This registry
 * adds immediate local interruption so a cancel request can close the active
 * Playwright browser instead of waiting for its next database checkpoint.
 */

const activeRuns = new Map()

export function beginHamiltonTaskRun(taskId) {
  const key = String(taskId || '')
  if (!key) throw new Error('taskId required')
  const prior = activeRuns.get(key)
  if (prior && !prior.signal.aborted) prior.abort({ code: 'superseded_run' })
  const controller = new AbortController()
  activeRuns.set(key, controller)
  return controller
}

export function finishHamiltonTaskRun(taskId, controller) {
  const key = String(taskId || '')
  if (key && activeRuns.get(key) === controller) activeRuns.delete(key)
}

export function cancelActiveHamiltonTaskRun(taskId, reason = 'cancelled_by_user') {
  const key = String(taskId || '')
  const controller = key ? activeRuns.get(key) : null
  if (!controller) return false
  if (!controller.signal.aborted) controller.abort({ code: 'task_cancelled', reason })
  activeRuns.delete(key)
  return true
}

export function hasActiveHamiltonTaskRun(taskId) {
  const controller = activeRuns.get(String(taskId || ''))
  return Boolean(controller && !controller.signal.aborted)
}
