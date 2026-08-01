/**
 * portalSessionLifetime.js
 *
 * THE LEDGER: how long does a captured portal session ACTUALLY stay
 * authenticated, per host — as an accumulating MEASUREMENT, not an assumption.
 *
 * WHY (2026-08-01)
 * ----------------
 * "Captured sessions are durable for most portals" was design intent plus a
 * code path. It had never been observed succeeding on a specific host, and the
 * code path that appeared to confirm it could not actually tell a live session
 * from a dead one (see `backend/config/portalSessionProfiles.js` for the live
 * evidence — a cookie-less browser was reported "refreshed" on 3 of 3 hosts).
 *
 * So prod carried `keepalive_refreshes: 11` on a studentaid.gov session whose
 * real sibling the owner measured dying in ~20 minutes, and NOTHING in the
 * database could answer "how long do this host's sessions live?".
 *
 * WHAT THIS RECORDS
 * -----------------
 * Only POSITIVE, unambiguous observations, each stamped with the session's AGE
 * at the moment of observation (age = observedAt − establishedAt, where
 * establishedAt is the moment a HUMAN authenticated, not the last cookie
 * refresh):
 *
 *   kind 'alive'  we requested an auth-gated path and got account content.
 *                 => this host's session survived AT LEAST `age`.
 *   kind 'dead'   we requested an auth-gated path and were moved to a sign-in
 *                 surface.
 *                 => this host's session was gone BY `age`.
 *
 * A wall, an outage, a CAPTCHA, a thin page, or a host with no auth-gated probe
 * path records NOTHING. Those are failures to observe, not observations — the
 * same distinction that keeps `AMOUNT_STATUS_NONE_PUBLISHED` honest, and the
 * same reason an outage never burns a row.
 *
 * The true lifetime for a host therefore lies in the interval
 *   [confirmedAliveMaxMs, confirmedDeadMinMs]
 * and every consumer is told which bound it has, so no surface can present a
 * lower bound as if it were the answer.
 *
 * STORAGE: `system_kv` key `portal_session_lifetime_observations` — the
 * existing pattern for cross-cutting learned state (UPDATE-then-INSERT, shim
 * safe). Bounded: `MAX_OBSERVATIONS_PER_HOST` newest kept per host.
 *
 * Best-effort throughout: never throws, so a ledger failure can never fail a
 * keep-alive sweep or a login-time read.
 */

import { createLogger } from '../../utils/logger.js'
import { resolvePortalSessionProfile } from '../../config/portalSessionProfiles.js'

const log = createLogger('service:portal-session-lifetime')

/** system_kv key holding the per-host observation ledger. */
export const LIFETIME_KV_KEY = 'portal_session_lifetime_observations'

/** Newest observations retained per host (bounded growth). */
export const MAX_OBSERVATIONS_PER_HOST = 50

export const OBSERVATION_ALIVE = 'alive'
export const OBSERVATION_DEAD = 'dead'

/** Provenance labels for a lifetime estimate — never let a seed read as a measurement. */
export const LIFETIME_SOURCE = Object.freeze({
  MEASURED: 'measured',              // we saw it die; the estimate is an upper bound we observed
  MEASURED_LOWER_BOUND: 'measured_lower_bound', // we only ever saw it alive
  SEED: 'seed',                      // registry guess; nothing observed yet
  UNKNOWN: 'unknown',                // no registry entry, nothing observed
})

function nowIso() { return new Date().toISOString() }

function parseTime(v) {
  if (!v) return NaN
  if (v instanceof Date) return v.getTime()
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : NaN
}

function normalizeHost(input) {
  return String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
}

async function ensureKvTable(db) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)',
  ).run()
}

/**
 * Read the ledger. Always returns a well-shaped object, even on any failure —
 * a missing/corrupt ledger must degrade to "no observations", never throw.
 *
 * @returns {Promise<{version:number, hosts:Record<string, {observations:Array}>}>}
 */
export async function loadLifetimeLedger(db) {
  const empty = { version: 1, hosts: {} }
  if (!db || typeof db.prepare !== 'function') return empty
  try {
    await ensureKvTable(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(LIFETIME_KV_KEY)
    if (!row?.value) return empty
    const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    if (!parsed || typeof parsed !== 'object' || !parsed.hosts || typeof parsed.hosts !== 'object') return empty
    return { version: Number(parsed.version) || 1, hosts: parsed.hosts }
  } catch (err) {
    log.warn('lifetime_ledger_read_failed', { err: err?.message })
    return empty
  }
}

/** Persist the ledger (UPDATE-then-INSERT; shim-safe). Best-effort. */
export async function saveLifetimeLedger(db, ledger) {
  if (!db || typeof db.prepare !== 'function' || !ledger) return false
  try {
    await ensureKvTable(db)
    const value = JSON.stringify({ version: 1, hosts: ledger.hosts || {} })
    const at = nowIso()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, at, LIFETIME_KV_KEY)
    const changed = Number(res?.changes ?? res?.rowCount ?? 0)
    if (changed === 0) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(LIFETIME_KV_KEY, value, at)
    }
    return true
  } catch (err) {
    log.warn('lifetime_ledger_write_failed', { err: err?.message })
    return false
  }
}

/**
 * Record ONE confirmed observation about a host's session.
 *
 * REFUSES (returns {recorded:false, reason}) when the observation cannot carry
 * meaning — an unknown kind, no host, or no usable establishedAt. A session
 * whose establishment time we do not know yields an age we would have to
 * invent, and an invented age is exactly the fabrication this module exists to
 * prevent.
 *
 * @param {object} db
 * @param {object} arg
 * @param {string} arg.host
 * @param {'alive'|'dead'} arg.kind
 * @param {string|Date} arg.establishedAt  when a HUMAN authenticated this session
 * @param {string|Date} [arg.observedAt]   defaults to now
 * @param {string} [arg.sessionId]
 * @returns {Promise<{recorded:boolean, reason?:string, ageMs?:number}>}
 */
export async function recordSessionObservation(db, {
  host, kind, establishedAt, observedAt = null, sessionId = null,
} = {}) {
  const h = normalizeHost(host)
  if (!h) return { recorded: false, reason: 'no_host' }
  if (kind !== OBSERVATION_ALIVE && kind !== OBSERVATION_DEAD) {
    return { recorded: false, reason: 'unknown_kind' }
  }
  const establishedMs = parseTime(establishedAt)
  if (!Number.isFinite(establishedMs)) return { recorded: false, reason: 'no_established_at' }
  const observedMs = observedAt ? parseTime(observedAt) : Date.now()
  if (!Number.isFinite(observedMs)) return { recorded: false, reason: 'bad_observed_at' }
  const ageMs = observedMs - establishedMs
  // A negative age means the two clocks disagree (or establishedAt was rewritten
  // to "now" by a refresh). Recording it would poison every bound derived from
  // this host, so refuse rather than guess.
  if (ageMs < 0) return { recorded: false, reason: 'negative_age' }

  try {
    const ledger = await loadLifetimeLedger(db)
    const entry = ledger.hosts[h] || { observations: [] }
    const observations = Array.isArray(entry.observations) ? entry.observations : []
    observations.push({
      kind,
      age_ms: ageMs,
      observed_at: new Date(observedMs).toISOString(),
      established_at: new Date(establishedMs).toISOString(),
      session_id: sessionId ? String(sessionId) : null,
    })
    // Bounded: keep the NEWEST observations.
    entry.observations = observations.slice(-MAX_OBSERVATIONS_PER_HOST)
    ledger.hosts[h] = entry
    await saveLifetimeLedger(db, ledger)
    return { recorded: true, ageMs }
  } catch (err) {
    log.warn('lifetime_observation_failed', { host: h, err: err?.message })
    return { recorded: false, reason: 'write_failed' }
  }
}

/**
 * Summarize what we have MEASURED for one host.
 *
 * The honest answer is an INTERVAL, and the caller is told which end we have:
 *   confirmedAliveMaxMs  longest age at which the session was proven alive
 *   confirmedDeadMinMs   shortest age at which it was proven dead
 *
 * `estimateMs` + `estimateSource` collapse that to one number ONLY for display,
 * and `estimateSource` always says whether it is a measurement, a lower bound,
 * or a registry seed.
 *
 * Pure over `ledger` — no I/O, so consumers can summarize many hosts from one read.
 */
export function summarizeHostLifetime(ledger, host) {
  const h = normalizeHost(host)
  const registry = resolvePortalSessionProfile(h)
  const observations = (ledger?.hosts?.[h]?.observations || []).filter(
    (o) => o && (o.kind === OBSERVATION_ALIVE || o.kind === OBSERVATION_DEAD) && Number.isFinite(Number(o.age_ms)),
  )

  let confirmedAliveMaxMs = null
  let confirmedDeadMinMs = null
  let lastConfirmedAliveAt = null
  let firstConfirmedDeadAt = null

  for (const o of observations) {
    const age = Number(o.age_ms)
    if (o.kind === OBSERVATION_ALIVE) {
      if (confirmedAliveMaxMs === null || age > confirmedAliveMaxMs) confirmedAliveMaxMs = age
      const t = parseTime(o.observed_at)
      const prev = parseTime(lastConfirmedAliveAt)
      if (Number.isFinite(t) && (!Number.isFinite(prev) || t > prev)) lastConfirmedAliveAt = o.observed_at
    } else {
      if (confirmedDeadMinMs === null || age < confirmedDeadMinMs) confirmedDeadMinMs = age
      const t = parseTime(o.observed_at)
      const prev = parseTime(firstConfirmedDeadAt)
      if (Number.isFinite(t) && (!Number.isFinite(prev) || t < prev)) firstConfirmedDeadAt = o.observed_at
    }
  }

  let estimateMs = null
  let estimateSource = LIFETIME_SOURCE.UNKNOWN
  if (confirmedDeadMinMs !== null) {
    // We watched it die. That age is a real upper bound on this host's lifetime.
    estimateMs = confirmedDeadMinMs
    estimateSource = LIFETIME_SOURCE.MEASURED
  } else if (confirmedAliveMaxMs !== null) {
    estimateMs = confirmedAliveMaxMs
    estimateSource = LIFETIME_SOURCE.MEASURED_LOWER_BOUND
  } else if (registry.observedLifetimeMs !== null
      && registry.observedLifetimeMs !== undefined
      && Number.isFinite(Number(registry.observedLifetimeMs))) {
    // The null check is load-bearing: `Number(null)` is 0, which IS finite, so
    // a bare Number.isFinite() would report every unregistered host as carrying
    // a 0ms "seed" lifetime — a fabricated estimate presented as a declared one.
    estimateMs = Number(registry.observedLifetimeMs)
    estimateSource = LIFETIME_SOURCE.SEED
  }

  return {
    host: h,
    samples: observations.length,
    aliveSamples: observations.filter((o) => o.kind === OBSERVATION_ALIVE).length,
    deadSamples: observations.filter((o) => o.kind === OBSERVATION_DEAD).length,
    confirmedAliveMaxMs,
    confirmedDeadMinMs,
    lastConfirmedAliveAt,
    firstConfirmedDeadAt,
    estimateMs,
    estimateSource,
    // True when nothing has ever been positively observed for this host, so a
    // UI can say "not measured yet" instead of implying a durable session.
    measured: estimateSource === LIFETIME_SOURCE.MEASURED
      || estimateSource === LIFETIME_SOURCE.MEASURED_LOWER_BOUND,
  }
}

/** Convenience: load + summarize one host. Never throws. */
export async function describeHostLifetime(db, host) {
  const ledger = await loadLifetimeLedger(db)
  return summarizeHostLifetime(ledger, host)
}

export default {
  LIFETIME_KV_KEY,
  MAX_OBSERVATIONS_PER_HOST,
  OBSERVATION_ALIVE,
  OBSERVATION_DEAD,
  LIFETIME_SOURCE,
  loadLifetimeLedger,
  saveLifetimeLedger,
  recordSessionObservation,
  summarizeHostLifetime,
  describeHostLifetime,
}
