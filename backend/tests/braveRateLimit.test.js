/**
 * Tests the Brave Search circuit breaker: it must tell a transient per-second
 * 429 from a monthly-quota-exhausted 429 (via the X-RateLimit-* headers) and
 * pause Brave for the right duration so Yana stops calling an exhausted key.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isBravePaused,
  braveCircuitState,
  noteBrave429,
  noteBraveSuccess,
  _resetBraveCircuit,
} from '../services/yana/braveRateLimit.js'

// Brave returns comma-separated windows shortest→longest (per-second, per-month).
function headers(map) {
  return { get: (k) => map[k.toLowerCase()] ?? null }
}

describe('braveRateLimit circuit breaker', () => {
  beforeEach(() => _resetBraveCircuit())

  it('starts closed (not paused)', () => {
    expect(isBravePaused()).toBe(false)
    expect(braveCircuitState().paused).toBe(false)
  })

  it('classifies a monthly-quota 429 as exhausted and pauses Brave', () => {
    const h = headers({
      'x-ratelimit-remaining': '0, 0',      // per-second 0, per-month 0
      'x-ratelimit-reset': '1, 3600',       // month resets in 3600s
    })
    const kind = noteBrave429({ headers: h })
    expect(kind).toBe('quota_exhausted')
    expect(isBravePaused()).toBe(true)
    const s = braveCircuitState()
    expect(s.reason).toBe('monthly_quota_exhausted')
    expect(s.resumes_in_minutes).toBeGreaterThan(0)
  })

  it('treats a single per-second 429 (month remaining > 0) as transient — no pause', () => {
    const h = headers({
      'x-ratelimit-remaining': '0, 1500',   // per-second spent, plenty of month left
      'x-ratelimit-reset': '1, 100000',
    })
    expect(noteBrave429({ headers: h })).toBe('transient')
    expect(isBravePaused()).toBe(false)
  })

  it('pauses after a sustained burst of 429s even without a quota header', () => {
    const h = headers({})
    let kind
    for (let i = 0; i < 5; i += 1) kind = noteBrave429({ headers: h })
    expect(kind).toBe('sustained')
    expect(isBravePaused()).toBe(true)
    expect(braveCircuitState().reason).toBe('sustained_429')
  })

  it('a success resets the transient counter so it takes another full burst to trip', () => {
    const h = headers({})
    noteBrave429({ headers: h })
    noteBrave429({ headers: h })
    noteBraveSuccess()
    // Only 4 more — not enough to hit the threshold of 5 from a clean counter.
    let kind
    for (let i = 0; i < 4; i += 1) kind = noteBrave429({ headers: h })
    expect(kind).toBe('transient')
    expect(isBravePaused()).toBe(false)
  })

  it('reports not-paused once the pause window has elapsed', () => {
    const now = 1_000_000
    const h = headers({ 'x-ratelimit-remaining': '0, 0', 'x-ratelimit-reset': '1, 60' })
    noteBrave429({ headers: h, now })
    expect(isBravePaused(now)).toBe(true)
    // 61s later (> 60s reset) the circuit reads closed.
    expect(isBravePaused(now + 61_000)).toBe(false)
    expect(braveCircuitState(now + 61_000).paused).toBe(false)
  })
})
