/**
 * maintenanceMode.js — coordinated "we're about to touch the code" window.
 *
 * Flow the owner asked for:
 *   1. Schedule maintenance → all signed-in users get a toast/banner warning
 *      with a grace period (default 5 min) and an estimated downtime.
 *   2. When the grace elapses the window flips to DOWN: non-admin API calls get
 *      503 and the frontend logs everyone out, so nobody is using a half-deployed
 *      app.
 *   3. End maintenance (once CI is green / Sam's nightly sweep is clean) → the
 *      app reopens.
 *
 * State lives in system_kv (single JSON row) so it survives restarts and the
 * warning→down transition is computed from timestamps (no per-process timer):
 * a restart mid-window resumes in the right phase. The owner/admin is never
 * locked out — they need access to do the work.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('maintenance')
const KV_KEY = 'maintenance_state'

const DEFAULT_GRACE_MIN = () => Number(process.env.MAINTENANCE_GRACE_MINUTES) || 5
const DEFAULT_EST_MIN = () => Number(process.env.MAINTENANCE_ESTIMATED_MINUTES) || 15

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function readRaw(db) {
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    return row?.value ? JSON.parse(row.value) : null
  } catch { return null }
}

async function writeRaw(db, state) {
  await ensureKv(db)
  const now = new Date().toISOString()
  const value = JSON.stringify(state)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
  const changed = Number(res?.changes ?? res?.rowCount ?? 0)
  if (!changed) await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
}

/** Effective phase from stored state at `now`: 'open' | 'warning' | 'down'. */
export function effectivePhase(state, now = new Date()) {
  if (!state || !state.active) return 'open'
  const grace = state.grace_until ? new Date(state.grace_until).getTime() : 0
  return now.getTime() >= grace ? 'down' : 'warning'
}

/** Public, safe-to-expose maintenance status for the frontend gate/banner. */
export async function getMaintenanceStatus(db, now = new Date()) {
  const state = await readRaw(db)
  const phase = effectivePhase(state, now)
  if (phase === 'open') return { phase: 'open', active: false }
  return {
    phase, // 'warning' | 'down'
    active: true,
    reason: state.reason || null,
    message: state.message || null,
    started_at: state.started_at || null,
    grace_until: state.grace_until || null,
    estimated_end_at: state.estimated_end_at || null,
    seconds_until_down: phase === 'warning' && state.grace_until
      ? Math.max(0, Math.round((new Date(state.grace_until).getTime() - now.getTime()) / 1000))
      : 0,
  }
}

/**
 * Schedule (or update) a maintenance window. Starts in WARNING for graceMinutes,
 * then flips to DOWN automatically. `estimatedMinutes` is the expected downtime
 * AFTER the grace period (used to show "back by ~HH:MM").
 */
export async function scheduleMaintenance(db, { graceMinutes = DEFAULT_GRACE_MIN(), estimatedMinutes = DEFAULT_EST_MIN(), reason = 'deploy', message = null, by = 'admin', now = new Date() } = {}) {
  const graceMs = Math.max(0, Number(graceMinutes)) * 60000
  const estMs = Math.max(1, Number(estimatedMinutes)) * 60000
  const graceUntil = new Date(now.getTime() + graceMs)
  const estimatedEnd = new Date(graceUntil.getTime() + estMs)
  const state = {
    active: true,
    reason,
    message: message || (reason === 'nightly_sweep'
      ? 'GrantFlow is running its nightly maintenance check. Please wrap up — the app will pause briefly.'
      : 'GrantFlow is going down for a brief maintenance update. Please finish what you\'re doing.'),
    started_at: now.toISOString(),
    grace_until: graceUntil.toISOString(),
    estimated_end_at: estimatedEnd.toISOString(),
    scheduled_by: by,
  }
  await writeRaw(db, state)
  log.info('maintenance scheduled', { reason, graceMinutes, estimatedMinutes, by })
  return getMaintenanceStatus(db, now)
}

/** Immediately enter DOWN (grace already elapsed) — used by the nightly sweep. */
export async function enterMaintenanceNow(db, { estimatedMinutes = DEFAULT_EST_MIN(), reason = 'deploy', message = null, by = 'system', now = new Date() } = {}) {
  return scheduleMaintenance(db, { graceMinutes: 0, estimatedMinutes, reason, message, by, now })
}

/** End maintenance and reopen the app. */
export async function endMaintenance(db, { by = 'admin' } = {}) {
  await writeRaw(db, { active: false, ended_at: new Date().toISOString(), ended_by: by })
  log.info('maintenance ended', { by })
  return { phase: 'open', active: false }
}

/**
 * Express guard: when the window is DOWN, non-admin API calls get 503 so the
 * frontend can log users out and show the maintenance screen. Admin/owner pass
 * through (they do the work). Read-only status + auth endpoints are exempt so
 * the frontend can still poll and the owner can still sign in.
 */
export function maintenanceGuard() {
  // Per-request cache key would be overkill; we read system_kv each call but it
  // is a single tiny indexed row. To avoid hammering the DB, cache for 5s.
  let cached = null
  let cachedAt = 0
  return async function maintenance(req, res, next) {
    try {
      // Use originalUrl: when mounted with app.use('/api', guard) Express strips
      // the '/api' prefix from req.path, so only originalUrl carries the full path.
      const path = req.originalUrl || req.url || ''
      // Always allow the status probe + auth + health so users can be told and
      // the owner can sign in to lift it.
      if (path.startsWith('/api/maintenance') || path.startsWith('/api/auth') || path.startsWith('/api/health') || path.startsWith('/readyz')) {
        return next()
      }
      const now = Date.now()
      if (!cached || now - cachedAt > 5000) {
        cached = await getMaintenanceStatus(req.db)
        cachedAt = now
      }
      if (cached?.phase !== 'down') return next()
      // Owner/admin keep working during the window.
      if (req.ctx?.isAdmin === true || req.user?.role === 'admin' || req.user?.is_admin) return next()
      return res.status(503).json({
        error: 'maintenance',
        message: cached.message || 'GrantFlow is briefly down for maintenance.',
        estimated_end_at: cached.estimated_end_at || null,
      })
    } catch {
      return next() // never let the guard itself break the API
    }
  }
}
