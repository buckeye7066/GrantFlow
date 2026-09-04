const trackedIntervals = new Set()
let shutdownHooksInstalled = false

function trackInterval(handle) {
  if (!handle) return handle
  trackedIntervals.add(handle)
  handle.unref?.()
  if (!shutdownHooksInstalled) {
    shutdownHooksInstalled = true
    const stopIntervals = () => {
      for (const timer of trackedIntervals) clearInterval(timer)
      trackedIntervals.clear()
    }
    process.once('SIGTERM', stopIntervals)
    process.once('SIGINT', stopIntervals)
  }
  return handle
}

/**
 * Start a non-overlapping async interval. A slow run is never allowed to stack
 * a second copy on top of itself; failures are consumed and surfaced with the
 * scheduler name so they cannot become process-level unhandled rejections.
 */
export function startGuardedBackgroundInterval({ name, intervalMs, task }) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error(`${name || 'background interval'} requires a positive intervalMs`)
  }
  if (typeof task !== 'function') {
    throw new Error(`${name || 'background interval'} requires a task function`)
  }

  let inFlight = false
  const tick = async () => {
    if (inFlight) {
      console.warn(`[background:${name}] previous run still in flight; skipping overlapping tick`)
      return { skipped: true, reason: 'already_running' }
    }
    inFlight = true
    try {
      await task()
      return { skipped: false, ok: true }
    } catch (error) {
      console.error(`[background:${name}] run failed:`, error?.message || error)
      return { skipped: false, ok: false, error }
    } finally {
      inFlight = false
    }
  }

  const handle = setInterval(() => {
    void tick()
  }, intervalMs)
  trackInterval(handle)
  return { handle, tick }
}
