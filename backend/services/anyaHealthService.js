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
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaHealthService')

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
    const expireSql = isPostgres
      ? `UPDATE funding_opportunities
         SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE is_active = TRUE
           AND deadline IS NOT NULL
           AND deadline < CURRENT_DATE
           AND deadline_type NOT IN ('rolling', 'ongoing')`
      : `UPDATE funding_opportunities
         SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE is_active = 1
           AND deadline IS NOT NULL
           AND deadline < date('now')
           AND deadline_type NOT IN ('rolling', 'ongoing')`
    const result = await db.prepare(expireSql).run()
    const count = result.changes ?? result.rowCount ?? 0
    status.expire_stale = { expired: count }
    if (count > 0) {
      log.info(`[AnyaHealth] Expired ${count} stale opportunities`)
    }
  } catch (err) {
    log.error('[AnyaHealth] expire_stale error:', err.message)
    status.errors.push({ task: 'expire_stale', error: err.message })
    status.expire_stale = { error: err.message }
  }

  // 2. Catalog/pipeline overlap audit — global catalog entries (profile_id NULL)
  // that share title+sponsor with a profile-scoped row. This is a BENIGN overlap
  // by design (the global row is the shared catalog entry; the profile-scoped row
  // is a user's matched/pipeline copy), NOT cross-tenant leakage — the real
  // cross-profile invariant (org-mismatch) is enforced in enforceInvariants.js.
  // Report-only + low-noise so it never reads as a privacy alarm.
  try {
    const bleedRows = await db
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
      log.info(`[AnyaHealth] catalog/pipeline overlap audit: ${bleedRows.length} global catalog row(s) also exist as a profile-scoped copy (benign overlap, report-only)`)
    }
  } catch (err) {
    log.error('[AnyaHealth] profile_bleed_check error:', err.message)
    status.errors.push({ task: 'profile_bleed_check', error: err.message })
    status.profile_bleed_check = { error: err.message }
  }

  // 3. Clean orphaned crawlers
  //
  // OLD behavior: marked ANY running job older than 2h as failed. This killed
  //   long-running but actively-progressing geo crawls that legitimately take
  //   3-6h to walk all 50 states. The geo dispatcher itself has a 6h hard
  //   timeout and graceful-stop logic between states, so a healthy long-running
  //   geo job should NOT be killed by this cleanup.
  //
  // NEW behavior:
  //   - QUEUED jobs > 2h old: still cleaned (never started, almost certainly stuck).
  //   - RUNNING jobs: only marked failed when their `last_heartbeat_at` is
  //     stale (>10 min without a ping). Healthy workers (geo crawler, anya
  //     orchestrator, profile enrichment) all bump the heartbeat at least
  //     every 60s. A 10-minute window is generous enough to absorb a slow
  //     batch / Postgres pause / network hiccup without false-killing the run.
  //   - Jobs whose `last_heartbeat_at` is NULL but whose `started_at` is
  //     >2h old are treated as orphaned (the worker died before ever
  //     heartbeating).
  try {
    const isPostgres = db?.dialect === 'postgres'
    const cleanOrphansSql = isPostgres
      ? `UPDATE crawler_jobs
         SET status = 'failed',
             completed_at = NOW(),
             error = COALESCE(error, 'Marked failed by AnyaHealth orphan cleanup: stale heartbeat or never-started queued job')
         WHERE (
           (status = 'queued' AND created_at < NOW() - INTERVAL '2 hours')
           OR (
             status = 'running'
             AND (
               (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - INTERVAL '10 minutes')
               OR (last_heartbeat_at IS NULL AND COALESCE(started_at, created_at) < NOW() - INTERVAL '2 hours')
             )
           )
         )`
      : `UPDATE crawler_jobs
         SET status = 'failed',
             completed_at = datetime('now'),
             error = COALESCE(error, 'Marked failed by AnyaHealth orphan cleanup: stale heartbeat or never-started queued job')
         WHERE (
           (status = 'queued' AND created_at < datetime('now', '-2 hours'))
           OR (
             status = 'running'
             AND (
               (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < datetime('now', '-10 minutes'))
               OR (last_heartbeat_at IS NULL AND COALESCE(started_at, created_at) < datetime('now', '-2 hours'))
             )
           )
         )`
    const result = await db.prepare(cleanOrphansSql).run()
    const count = result.changes ?? result.rowCount ?? 0
    status.orphaned_crawlers = { cleaned: count }
    if (count > 0) {
      log.info(`[AnyaHealth] Cleaned ${count} orphaned crawler jobs (stale heartbeat or stuck queued)`)
    }
  } catch (err) {
    // crawler_jobs table may not exist in all environments — not fatal
    if (!err.message?.includes('no such table') && !err.message?.includes('does not exist')) {
      log.error('[AnyaHealth] orphaned_crawlers error:', err.message)
      status.errors.push({ task: 'orphaned_crawlers', error: err.message })
    }
    status.orphaned_crawlers = { error: err.message }
  }

  // 4. Audit profile signals — find profiles missing key section data
  try {
    // Query actual schema: profiles table + profile_sections for depth data
    let profiles
    try {
      profiles = await db
        .prepare(
          "SELECT id, display_name, primary_type FROM profiles WHERE deleted_at IS NULL",
        )
        .all()
    } catch (profileErr) {
      const msg = String(profileErr?.message || '').toLowerCase()
      if (!msg.includes('deleted_at') && !msg.includes('no such column') && !msg.includes('does not exist')) {
        throw profileErr
      }
      profiles = await db
        .prepare(
          "SELECT id, display_name, primary_type FROM profiles WHERE status IS NULL OR status <> 'deleted'",
        )
        .all()
    }
    const sectionCounts = await db
      .prepare(
        "SELECT profile_id, section_key FROM profile_sections",
      )
      .all()
    const sectionsByProfile = {}
    for (const row of sectionCounts) {
      if (!sectionsByProfile[row.profile_id]) sectionsByProfile[row.profile_id] = new Set()
      sectionsByProfile[row.profile_id].add(row.section_key)
    }
    const missingType = profiles.filter((p) => !p.primary_type)
    const missingBasic = profiles.filter((p) => !sectionsByProfile[p.id]?.has('basic_information'))
    const missingFinancial = profiles.filter((p) => !sectionsByProfile[p.id]?.has('financial_information'))
    const missingDepthSections = profiles.filter(
      (p) => {
        const s = sectionsByProfile[p.id]
        return !s || (!s.has('health_medical') && !s.has('demographics') && !s.has('financial_information'))
      },
    )
    status.profile_signal_audit = {
      total_active: profiles.length,
      missing_type: missingType.length,
      missing_basic: missingBasic.length,
      missing_financial: missingFinancial.length,
      missing_all_depth_sections: missingDepthSections.length,
      missing_type_ids: missingType.slice(0, 10).map((p) => p.id),
      missing_basic_ids: missingBasic.slice(0, 10).map((p) => p.id),
    }
    if (missingType.length > 0 || missingBasic.length > 0 || missingDepthSections.length > 0) {
      console.warn(
        `[AnyaHealth] Profile signal gaps: ${missingType.length} missing type, ${missingBasic.length} missing basic info, ${missingDepthSections.length} missing all depth sections`,
      )
    }
  } catch (err) {
    log.error('[AnyaHealth] profile_signal_audit error:', err.message)
    status.errors.push({ task: 'profile_signal_audit', error: err.message })
    status.profile_signal_audit = { error: err.message }
  }

  // 5. Deduplicate global catalog — merge exact title+sponsor+state duplicates
  try {
    // Find duplicate groups (profile_id IS NULL only — never touch profile-scoped records)
    const dupGroups = await db
      .prepare(
        `SELECT title, sponsor, state, COUNT(*) as cnt, MIN(id) as keep_id
         FROM funding_opportunities
         WHERE profile_id IS NULL
         GROUP BY title, sponsor, state
         HAVING COUNT(*) > 1
         LIMIT 200`,
      )
      .all()

    const isPostgresDup = db?.dialect === 'postgres'
    let removed = 0
    for (const group of dupGroups) {
      try {
        // Prefer the duplicate with a valid application_url; fall back to MIN(id)
        // PostgreSQL: use IS NOT DISTINCT FROM for null-safe equality (avoids untyped parameter error)
        const nullSafeSponsor = isPostgresDup ? 'sponsor IS NOT DISTINCT FROM ?' : '(sponsor = ? OR (sponsor IS NULL AND ? IS NULL))'
        const nullSafeState = isPostgresDup ? 'state IS NOT DISTINCT FROM ?' : '(state = ? OR (state IS NULL AND ? IS NULL))'
        const bestRow = await db
          .prepare(
            `SELECT id FROM funding_opportunities
             WHERE profile_id IS NULL
               AND title = ?
               AND ${nullSafeSponsor}
               AND ${nullSafeState}
             ORDER BY
               CASE WHEN application_url IS NOT NULL AND application_url != '' THEN 0 ELSE 1 END ASC,
               id ASC
             LIMIT 1`,
          )
          .get(...(isPostgresDup
            ? [group.title, group.sponsor, group.state]
            : [group.title, group.sponsor, group.sponsor, group.state, group.state]))
        if (!bestRow) continue
        const keepId = bestRow.id
        // Collect IDs to be removed for audit log
        const toRemove = await db
          .prepare(
            `SELECT id FROM funding_opportunities
             WHERE profile_id IS NULL
               AND title = ?
               AND ${nullSafeSponsor}
               AND ${nullSafeState}
               AND id != ?`,
          )
          .all(...(isPostgresDup
            ? [group.title, group.sponsor, group.state, keepId]
            : [group.title, group.sponsor, group.sponsor, group.state, group.state, keepId]))
        if (toRemove.length === 0) continue

        // Reassign dependent grants to the kept opportunity BEFORE deleting dupes,
        // otherwise the FK grants_funding_opportunity_id_fkey blocks the DELETE.
        // Guarded by IN (...) so we only touch rows pointing at ids we're about to remove.
        const removeIds = toRemove.map((r) => r.id)
        const placeholders = removeIds.map(() => '?').join(', ')
        try {
          await db
            .prepare(
              `UPDATE grants SET funding_opportunity_id = ?
               WHERE funding_opportunity_id IN (${placeholders})`,
            )
            .run(keepId, ...removeIds)
        } catch (reassignErr) {
          // If reassignment itself fails, skip the delete for this group rather
          // than attempt a DELETE that will surely fail on the same FK.
          console.warn('[AnyaHealth] dedup reassign grants failed; skipping group', {
            title: group.title,
            error: reassignErr?.message,
          })
          continue
        }

        const result = await db
          .prepare(
            `DELETE FROM funding_opportunities
             WHERE profile_id IS NULL
               AND title = ?
               AND ${nullSafeSponsor}
               AND ${nullSafeState}
               AND id != ?`,
          )
          .run(...(isPostgresDup
            ? [group.title, group.sponsor, group.state, keepId]
            : [group.title, group.sponsor, group.sponsor, group.state, group.state, keepId]))
        const delta = result.changes ?? result.rowCount ?? 0
        removed += delta
        if (delta > 0) {
          log.info(
            `[AnyaHealth] dedup: kept id=${keepId}, removed ids=${toRemove.map((r) => r.id).join(',')}, title="${group.title}"`,
          )
        }
      } catch (delErr) {
        // Non-fatal: log and continue
        log.error('[AnyaHealth] dedup delete error:', delErr.message)
      }
    }

    status.dedup_opportunities = { groups_found: dupGroups.length, removed }
    if (removed > 0) {
      log.info(`[AnyaHealth] Deduped ${removed} duplicate global catalog entries across ${dupGroups.length} groups`)
    }
  } catch (err) {
    log.error('[AnyaHealth] dedup_opportunities error:', err.message)
    status.errors.push({ task: 'dedup_opportunities', error: err.message })
    status.dedup_opportunities = { error: err.message }
  }

  // 6. Auto-repair scan — non-critical dry-run code quality check
  try {
    const repairReport = await runAutoRepair(db, { dryRun: true })
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
    log.info('[AnyaHealth] Service already running — skipping duplicate start')
    return { stop: stopHealthService }
  }

  _db = db
  const intervalMs = Number(process.env.ANYA_HEALTH_INTERVAL_MS) || DEFAULT_INTERVAL_MS

  log.info(`[AnyaHealth] Starting background health service (interval: ${intervalMs}ms)`)

  async function tick() {
    if (_running) return
    _running = true
    try {
      _lastStatus = await runHealthCheck(_db)
    } catch (err) {
      log.error('[AnyaHealth] Uncaught error in health check:', err.message)
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
    log.info('[AnyaHealth] Service stopped')
  }
}

/**
 * Returns the most recent health status (null if no check has run yet).
 */
export function getLastHealthStatus() {
  return _lastStatus
}
