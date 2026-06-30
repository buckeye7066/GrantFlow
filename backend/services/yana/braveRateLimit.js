/**
 * braveRateLimit.js — circuit breaker for the Brave Search API key.
 *
 * Brave's free tier enforces BOTH a ~1 request/second rate limit AND a monthly
 * quota (~2,000 queries). A per-second 429 is transient; a MONTHLY-quota 429
 * means the key is EXHAUSTED until the calendar month resets — at which point
 * every Brave request 429s. Without a breaker, Yana (and Robert/John, which
 * share the same key) would keep firing thousands of doomed requests, wasting
 * work and hammering an already-throttled key.
 *
 * This module lets the Brave provider record a 429 — parsing Brave's
 * `X-RateLimit-*` headers to tell quota-exhaustion from a transient blip — and
 * OPENS the circuit for the right duration. While open, callers skip Brave
 * entirely (returning no results fast) so Yana's live-web work pauses until the
 * key refills, instead of churning. The state is observable (braveCircuitState)
 * so Yana's status — and therefore Sam/Anya/Mission Control — can show it.
 */
import { createLogger } from '../../utils/logger.js'

const log = createLogger('braveRateLimit')

const MONTH_MS = 31 * 24 * 60 * 60 * 1000
// When Brave reports the monthly quota is gone but gives no usable reset time,
// re-probe in this long window rather than guessing the exact month boundary.
const DEFAULT_EXHAUSTED_MS = 6 * 60 * 60 * 1000
// A burst of 429s with no quota header still means "stop for a bit".
const SUSTAINED_429_THRESHOLD = 5
const SUSTAINED_PAUSE_MS = 5 * 60 * 1000

let pausedUntil = 0
let reason = null
let consecutive429 = 0

function parseHeaderList(value) {
  if (value === null || value === undefined) return []
  return String(value)
    .split(',')
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n))
}

function getHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name] ?? headers[name.toLowerCase()] ?? null
}

/** True while the Brave circuit is open (callers should skip Brave). */
export function isBravePaused(now = Date.now()) {
  return now < pausedUntil
}

/** Observable circuit state for agent status / dashboards. */
export function braveCircuitState(now = Date.now()) {
  const paused = now < pausedUntil
  return {
    paused,
    reason: paused ? reason : null,
    resumes_at: paused ? new Date(pausedUntil).toISOString() : null,
    resumes_in_minutes: paused ? Math.ceil((pausedUntil - now) / 60000) : 0,
  }
}

/** Open the circuit for `ms` (capped at a month) with a reason. */
export function pauseBrave(ms, why, now = Date.now()) {
  const until = now + Math.max(0, Math.min(ms, MONTH_MS))
  if (until > pausedUntil) {
    pausedUntil = until
    reason = why
    log.warn(`Brave circuit OPEN (${why}) — pausing Brave calls until ${new Date(pausedUntil).toISOString()}`)
  }
}

/** A successful Brave call closes the transient-429 counter. */
export function noteBraveSuccess() {
  consecutive429 = 0
}

/**
 * Record a 429 from Brave. Parses the rate-limit headers to classify it and
 * opens the circuit when warranted.
 * @returns {'quota_exhausted'|'sustained'|'transient'}
 */
export function noteBrave429({ headers, now = Date.now() } = {}) {
  consecutive429 += 1
  const remaining = parseHeaderList(getHeader(headers, 'x-ratelimit-remaining'))
  const resets = parseHeaderList(getHeader(headers, 'x-ratelimit-reset'))
  const retryAfter = Number(getHeader(headers, 'retry-after'))

  // Brave lists rate-limit windows shortest→longest, so the LAST element is the
  // monthly quota. remaining===0 there means the key is spent for the month.
  const monthlyRemaining = remaining.length ? remaining[remaining.length - 1] : null
  if (monthlyRemaining === 0) {
    const resetSecs = resets.length ? resets[resets.length - 1] : null
    const ms = Number.isFinite(resetSecs) && resetSecs > 0 ? resetSecs * 1000 : DEFAULT_EXHAUSTED_MS
    pauseBrave(ms, 'monthly_quota_exhausted', now)
    return 'quota_exhausted'
  }

  // No quota signal, but a sustained burst of 429s → back off for a few minutes.
  if (consecutive429 >= SUSTAINED_429_THRESHOLD) {
    const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : SUSTAINED_PAUSE_MS
    pauseBrave(Math.max(ms, SUSTAINED_PAUSE_MS), 'sustained_429', now)
    return 'sustained'
  }

  return 'transient'
}

/** Test-only reset. */
export function _resetBraveCircuit() {
  pausedUntil = 0
  reason = null
  consecutive429 = 0
}

export default { isBravePaused, braveCircuitState, pauseBrave, noteBraveSuccess, noteBrave429 }
