function nowMs() {
  return Date.now()
}

/**
 * Very small in-memory circuit breaker (per process).
 * - closed: calls go through; failures increment counter
 * - open: calls fail fast until cooldown passes
 * - half_open: allow one call; success closes, failure re-opens
 */
export function createCircuitBreaker({
  name = 'breaker',
  failureThreshold = 3,
  cooldownMs = 30_000,
} = {}) {
  let state = 'closed' // 'closed' | 'open' | 'half_open'
  let failures = 0
  let openedAt = 0

  function snapshot() {
    return {
      name,
      state,
      failures,
      openedAt: openedAt || null,
      cooldownMs,
      failureThreshold,
      canAttempt: state !== 'open' || nowMs() - openedAt >= cooldownMs,
    }
  }

  function open() {
    state = 'open'
    openedAt = nowMs()
  }

  function close() {
    state = 'closed'
    failures = 0
    openedAt = 0
  }

  async function exec(fn, { shouldTrip } = {}) {
    const snap = snapshot()
    if (snap.state === 'open' && !snap.canAttempt) {
      const err = new Error(`[${name}] temporarily unavailable (circuit open)`)
      err.code = 'CIRCUIT_OPEN'
      err.status = 503
      err.details = snap
      throw err
    }

    if (snap.state === 'open' && snap.canAttempt) {
      state = 'half_open'
    }

    try {
      const result = await fn()
      close()
      return result
    } catch (error) {
      const trip = typeof shouldTrip === 'function' ? Boolean(shouldTrip(error)) : true

      if (trip) {
        failures += 1
        if (failures >= failureThreshold || state === 'half_open') {
          open()
        }
      }
      throw error
    }
  }

  return { exec, snapshot }
}

