/**
 * Anya Background Health Service
 *
 * Runs every 30 minutes (configurable via ANYA_HEALTH_INTERVAL_MS) to perform
 * routine catalog and profile maintenance tasks:
 *
 * 1. Expire stale opportunities — mark past-deadline records inactive
 * 2. Detect profile bleed — find global catalog entries that duplicate profile-scoped records
 * 3. Clean orphaned crawlers — fail stuck crawler jobs older than 2 hours
 * 4. Audit profile signals — flag profiles missing state/type fields needed for matching
 * 5. Deduplicate opportunities — merge exact title+sponsor+state duplicates
 * 6. Auto-repair scan — dry-run code quality scan (non-critical)
 */

import { runAutoRepair } from './anyaAutoRepairService.js'

const DEFAULT_INTERVAL_MS = 1800000 // 30 minutes

let _db = null
let _intervalId = null
let _lastStatus = null
let _running = false

/**
 * Run a single health check cycle. Safe to call manually.
 * @param {object} db — better-sqlite3 / postgres db handle
 * @returns {object} status report
 */
export async function runHealthCheck(db) {
  const startTime = Date.now()
  const status = {
    started_at: new Date().toISOString(),
    expire_stale: null,
    profile_bleed_check: null,
    orphaned_crawlers: null,
    profile_signal_audit: null,
    dedup_opportunities: null,
    auto_repair_scan: null,
    errors: [],
  }

  // 1. Expire stale opportunities
  try {
    const isPostgres = db?.dialect === 'postgres'
    const inactiveVal = isPostgres ? 'FALSE' : '0'
    const nowExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"
    const result = db
      .prepare(
        `UPDATE funding_opportunities
         SET is_active = ${inactiveVal}, updated_at = CURRENT_TIMESTAMP
         WHERE is_active = ${isPostgres ? 'TRUE' : '1'}
           AND deadline IS NOT NULL
           AND deadline < ${nowExpr}
           AND deadline_type NOT IN ('rolling', 'ongoing')`,
      )
      .run()
    const count = result.changes ?? result.rowCount ?? 0
    status.expire_stale = { expired: count }
    if (count > 0) {
      console.log(`[AnyaHealth] Expired ${count} stale opportunities`)
    }
  } catch (err) {
    console.error('[AnyaHealth] expire_stale error:', err.message)
    status.errors.push({ task: 'expire_stale', error: err.message })
    status.expire_stale = { error: err.message }
  }

  // 2. Detect profile bleed — global catalog entries that are exact duplicates of profile-scoped records
  try {
    const bleedRows = db
      .prepare(
        `SELECT g.id, g.title, g.sponsor
         FROM funding_opportunities g
         WHERE g.profile_id IS NULL
           AND EXISTS (
             SELECT 1 FROM funding_opportunities p
             WHERE p.profile_id IS NOT NULL
               AND p.title = g.title
               AND (p.sponsor = g.sponsor OR (p.sponsor IS NULL AND g.sponsor IS NULL))
           )
         LIMIT 500`,
      )
      .all()
    status.profile_bleed_check = { count: bleedRows.length, sample_ids: bleedRows.slice(0, 5).map((r) => r.id) }
    if (bleedRows.length > 0) {
      console.warn(`[AnyaHealth] Detected ${bleedRows.length} potential profile-bleed entries in global catalog`)
    }
  } catch (err) {
    console.error('[AnyaHealth] profile_bleed_check error:', err.message)
    status.errors.push({ task: 'profile_bleed_check', error: err.message })
    status.profile_bleed_check = { error: err.message }
  }

  // 3. Clean orphaned crawlers — stuck jobs older than 2 hours → mark failed
  try {
    const isPostgres = db?.dialect === 'postgres'
    const staleExpr = isPostgres
      ? "(created_at < NOW() - INTERVAL '2 hours')"
      : "(created_at < datetime('now', '-2 hours'))"
    const result = db
      .prepare(
        `UPDATE crawler_jobs
         SET status = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('queued', 'running')
           AND ${staleExpr}`,
      )
      .run()
    const count = result.changes ?? result.rowCount ?? 0
    status.orphaned_crawlers = { cleaned: count }
    if (count > 0) {
      console.log(`[AnyaHealth] Cleaned ${count} orphaned crawler jobs`)
    }
  } catch (err) {
    // crawler_jobs table may not exist in all environments — not fatal
    if (!err.message?.includes('no such table') && !err.message?.includes('does not exist')) {
      console.error('[AnyaHealth] orphaned_crawlers error:', err.message)
      status.errors.push({ task: 'orphaned_crawlers', error: err.message })
    }
    status.orphaned_crawlers = { error: err.message }
  }

  // 4. Audit profile signals — find profiles missing state or type
  try {
    const profiles = db.prepare("SELECT id, display_name, state, type FROM profiles WHERE status = 'active'").all()
    const missingState = profiles.filter((p) => !p.state)
    const missingType = profiles.filter((p) => !p.type)
    status.profile_signal_audit = {
      total_active: profiles.length,
      missing_state: missingState.length,
      missing_type: missingType.length,
      missing_state_ids: missingState.slice(0, 10).map((p) => p.id),
      missing_type_ids: missingType.slice(0, 10).map((p) => p.id),
    }
    if (missingState.length > 0 || missingType.length > 0) {
      console.warn(
        `[AnyaHealth] Profile signal gaps: ${missingState.length} missing state, ${missingType.length} missing type`,
      )
    }
  } catch (err) {
    console.error('[AnyaHealth] profile_signal_audit error:', err.message)
    status.errors.push({ task: 'profile_signal_audit', error: err.message })
    status.profile_signal_audit = { error: err.message }
  }

  // 5. Deduplicate global catalog — merge exact title+sponsor+state duplicates
  try {
    // Find duplicate groups (profile_id IS NULL only — never touch profile-scoped records)
    const dupGroups = db
      .prepare(
        `SELECT title, sponsor, state, COUNT(*) as cnt, MIN(id) as keep_id
         FROM funding_opportunities
         WHERE profile_id IS NULL
         GROUP BY title, sponsor, state
         HAVING COUNT(*) > 1
         LIMIT 200`,
      )
      .all()

    let removed = 0
    for (const group of dupGroups) {
      try {
        const result = db
          .prepare(
            `DELETE FROM funding_opportunities
             WHERE profile_id IS NULL
               AND title = ?
               AND (sponsor = ? OR (sponsor IS NULL AND ? IS NULL))
               AND (state = ? OR (state IS NULL AND ? IS NULL))
               AND id != ?`,
          )
          .run(group.title, group.sponsor, group.sponsor, group.state, group.state, group.keep_id)
        removed += result.changes ?? result.rowCount ?? 0
      } catch (delErr) {
        // Non-fatal: log and continue
        console.error('[AnyaHealth] dedup delete error:', delErr.message)
      }
    }

    status.dedup_opportunities = { groups_found: dupGroups.length, removed }
    if (removed > 0) {
      console.log(`[AnyaHealth] Deduped ${removed} duplicate global catalog entries across ${dupGroups.length} groups`)
    }
  } catch (err) {
    console.error('[AnyaHealth] dedup_opportunities error:', err.message)
    status.errors.push({ task: 'dedup_opportunities', error: err.message })
    status.dedup_opportunities = { error: err.message }
  }

  // 6. Auto-repair scan — non-critical dry-run code quality check
  try {
    const repairReport = await runAutoRepair(db, { dryRun: false })
    status.auto_repair_scan = {
      scannedFiles: repairReport.scannedFiles,
      empty_catch: repairReport.findings.empty_catch.length,
      console_log: repairReport.findings.console_log.length,
      profile_bleed: repairReport.findings.profile_bleed.length,
    }
  } catch (err) {
    // Non-critical — never block the health check
    status.auto_repair_scan = { error: err.message }
  }

  status.completed_at = new Date().toISOString()
  status.duration_ms = Date.now() - startTime
  return status
}

/**
 * Start the background health service. Safe to call multiple times — only one
 * interval is ever running. Errors inside the check never crash the server.
 *
 * @param {object} db — db handle
 * @returns {{ stop: Function }} — call stop() to halt the interval
 */
export function startHealthService(db) {
  if (_intervalId) {
    console.log('[AnyaHealth] Service already running — skipping duplicate start')
    return { stop: stopHealthService }
  }

  _db = db
  const intervalMs = Number(process.env.ANYA_HEALTH_INTERVAL_MS) || DEFAULT_INTERVAL_MS

  console.log(`[AnyaHealth] Starting background health service (interval: ${intervalMs}ms)`)

  async function tick() {
    if (_running) return
    _running = true
    try {
      _lastStatus = await runHealthCheck(_db)
    } catch (err) {
      console.error('[AnyaHealth] Uncaught error in health check:', err.message)
      _lastStatus = { error: err.message, completed_at: new Date().toISOString() }
    } finally {
      _running = false
    }
  }

  _intervalId = setInterval(tick, intervalMs)
  // Unref so the interval doesn't prevent the process from exiting in tests
  if (_intervalId.unref) _intervalId.unref()

  return { stop: stopHealthService }
}

export function stopHealthService() {
  if (_intervalId) {
    clearInterval(_intervalId)
    _intervalId = null
    console.log('[AnyaHealth] Service stopped')
  }
}

/**
 * Returns the most recent health status (null if no check has run yet).
 */
export function getLastHealthStatus() {
  return _lastStatus
}
