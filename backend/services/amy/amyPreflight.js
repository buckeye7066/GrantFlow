const DEFAULT_TIMEOUT_MS = 30_000

function timeoutError(label, timeoutMs) {
  const error = new Error(`Amy preflight step "${label}" exceeded ${timeoutMs}ms`)
  error.code = 'AMY_PREFLIGHT_TIMEOUT'
  error.step = label
  error.timeout_ms = timeoutMs
  return error
}

/**
 * Bound non-essential work that happens before Amy creates her first synthetic
 * profile. A slow mesh read, coverage-scoreboard refresh, or condition-source
 * search must never hold the two-hour scheduler lease while producing zero
 * cohort evidence.
 *
 * The underlying task may finish later, so callers use this only for
 * best-effort/read-mostly preflight work whose late completion is safe. The
 * returned fallback lets the training loop proceed deterministically.
 */
export async function boundedAmyPreflight(label, task, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fallback = null,
  logger = console,
} = {}) {
  if (typeof task !== 'function') throw new Error('boundedAmyPreflight: task is required')
  const limit = Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  let timer = null
  try {
    const work = Promise.resolve().then(task)
    // A timed-out task is intentionally detached but never left with an
    // unhandled rejection.
    work.catch(() => {})
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, limit)), limit)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } catch (error) {
    logger?.warn?.('Amy preflight step degraded; continuing with fallback', {
      step: label,
      timeout_ms: limit,
      timed_out: error?.code === 'AMY_PREFLIGHT_TIMEOUT',
      error: String(error?.message || error),
    })
    return typeof fallback === 'function' ? fallback(error) : fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export default { boundedAmyPreflight }
