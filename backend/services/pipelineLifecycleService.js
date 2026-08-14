import { createLogger } from '../utils/logger.js'
const log = createLogger('pipelineLifecycleService')
/**
 * pipelineLifecycleService.js
 *
 * Pipeline Lifecycle Service
 *
 * Automated pipeline hygiene:
 * - Auto-archives expired grants (status → "archived") based on deadline column
 * - Flags stale grants (status = "discovered" for > staleDays with no action)
 * - Detects potential new grant cycles (deadline in the past, new cycle may be open)
 * - Generates lifecycle reports per profile
 *
 * Can be imported as a service or run as a standalone script.
 *
 * @module pipelineLifecycleService
 */

// ── Date helpers ───────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0] // YYYY-MM-DD
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1)
  const d2 = new Date(dateStr2)
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24))
}

function isExpired(deadlineStr) {
  if (!deadlineStr) return false
  try {
    // Compare as strings (both YYYY-MM-DD) to avoid timezone shifts
    return deadlineStr.slice(0, 10) < today()
  } catch {
    return false
  }
}

// ── Archive expired grants ────────────────────────────────────────────────────

/**
 * Archive grants whose deadline has passed and status is still active.
 *
 * Active statuses are: discovery, discovered, interested, drafting, application_prep, revision.
 * Grants that are submitted, awarded, declined, closed, or already archived are left alone.
 *
 * @param {Object} db - Better-sqlite3 or compatible async DB instance
 * @returns {{ archived: Object[] }}
 */
export async function archiveExpiredGrants(db) {
  if (!db) return { archived: [] }

  const ARCHIVEABLE_STATUSES = [
    'discovery', 'discovered', 'interested', 'drafting',
    'application_prep', 'app_prep', 'revision', 'auto_applied',
  ]

  const placeholders = ARCHIVEABLE_STATUSES.map(() => '?').join(',')
  const cutoff = today()

  let expiredGrants
  try {
    const stmt = db.prepare(
      `SELECT id, title, profile_id, organization_id, deadline, status
       FROM grants
       WHERE deadline IS NOT NULL
         AND deadline < ?
         AND status IN (${placeholders})`
    )
    expiredGrants = await stmt.all(cutoff, ...ARCHIVEABLE_STATUSES)
  } catch (err) {
    log.error('[pipelineLifecycle] archiveExpiredGrants query failed:', err?.message || err)
    return { archived: [] }
  }

  if (!expiredGrants || expiredGrants.length === 0) return { archived: [] }

  const archived = []
  for (const grant of expiredGrants) {
    try {
      const updateStmt = db.prepare(
        `UPDATE grants
         SET status = 'archived',
             updated_at = CURRENT_TIMESTAMP,
             notes = COALESCE(notes || ' | ', '') || 'Auto-archived: deadline passed (' || deadline || ')'
         WHERE id = ?`
      )
      await updateStmt.run(grant.id)
      archived.push({ ...grant, newStatus: 'archived' })
    } catch {
      // Individual update failure is non-fatal
    }
  }

  return { archived }
}

// ── Flag stale discoveries ────────────────────────────────────────────────────

/**
 * Flag grants that have been in "discovered" status for longer than staleDays
 * without any user action. Adds a note but does not change the status.
 *
 * @param {Object} db - DB instance
 * @param {number} [staleDays=60] - Days after which a discovered grant is considered stale
 * @returns {{ flagged: Object[] }}
 */
export async function flagStaleDiscoveries(db, staleDays = 60) {
  if (!db) return { flagged: [] }

  const cutoff = daysAgo(staleDays)

  let staleGrants
  try {
    const staleStmt = db.prepare(
      `SELECT id, title, profile_id, organization_id, created_at, status
       FROM grants
       WHERE status = 'discovered'
         AND created_at < ?
         AND (notes IS NULL OR notes NOT LIKE '%stale%')`
    )
    staleGrants = await staleStmt.all(cutoff)
  } catch (err) {
    log.error('[pipelineLifecycle] flagStaleDiscoveries query failed:', err?.message || err)
    return { flagged: [] }
  }

  if (!staleGrants || staleGrants.length === 0) return { flagged: [] }

  const flagged = []
  for (const grant of staleGrants) {
    try {
      const age = daysBetween(grant.created_at, today())
      const flagStmt = db.prepare(
        `UPDATE grants
         SET updated_at = CURRENT_TIMESTAMP,
             notes = COALESCE(notes || ' | ', '') || 'Stale: discovered ' || ? || ' days ago with no action'
         WHERE id = ?`
      )
      await flagStmt.run(age, grant.id)
      flagged.push({ ...grant, daysStale: age })
    } catch {
      // Non-fatal
    }
  }

  return { flagged }
}

// ── Detect new cycles ─────────────────────────────────────────────────────────

/**
 * Find grants that are archived/closed but whose deadline was more than 8 months ago,
 * suggesting a new annual cycle may now be open.
 *
 * @param {Object} db - DB instance
 * @returns {{ newCycles: Object[] }}
 */
export async function detectNewCycles(db) {
  if (!db) return { newCycles: [] }

  // 8 months ≈ 240 days — programs with annual cycles should have reopened
  const cycleThreshold = daysAgo(240)

  let candidates
  try {
    const cycleStmt = db.prepare(
      `SELECT id, title, profile_id, organization_id, deadline, application_url, status
       FROM grants
       WHERE status IN ('archived', 'closed', 'declined', 'declined_no_review')
         AND deadline IS NOT NULL
         AND deadline < ?
         AND (notes IS NULL OR notes NOT LIKE '%new cycle detected%')
       ORDER BY deadline ASC
       LIMIT 200`
    )
    candidates = await cycleStmt.all(cycleThreshold)
  } catch (err) {
    log.error('[pipelineLifecycle] detectNewCycles query failed:', err?.message || err)
    return { newCycles: [] }
  }

  if (!candidates || candidates.length === 0) return { newCycles: [] }

  const newCycles = []
  for (const grant of candidates) {
    try {
      await db
        .prepare(
          `UPDATE grants
           SET notes = COALESCE(notes || ' | ', '') || 'New cycle detected: original deadline was ' || deadline || ' — check for a new application window'
           WHERE id = ?`,
        )
        .run(grant.id)
      newCycles.push(grant)
    } catch {
      // Non-fatal
    }
  }

  return { newCycles }
}

// ── Per-profile lifecycle report ──────────────────────────────────────────────

/**
 * @typedef {Object} ProfileReport
 * @property {string} profileId
 * @property {string} profileName
 * @property {number} totalGrants
 * @property {number} archivedInRun
 * @property {number} flaggedStaleInRun
 * @property {number} newCyclesInRun
 * @property {{ status: string, count: number }[]} statusBreakdown
 */

/**
 * Build a per-profile summary from the run results.
 *
 * @param {Object} db - DB instance
 * @param {Object} runResults - { archived, flagged, newCycles }
 * @returns {ProfileReport[]}
 */
async function buildProfileReports(db, runResults) {
  let profiles
  try {
    const profileStmt = db.prepare('SELECT id, display_name FROM profiles ORDER BY display_name')
    profiles = await profileStmt.all()
  } catch {
    return []
  }

  const reports = []
  for (const profile of profiles) {
    let breakdown
    try {
      const breakdownStmt = db.prepare(
        `SELECT status, COUNT(*) as count
         FROM grants
         WHERE profile_id = ?
         GROUP BY status`
      )
      breakdown = await breakdownStmt.all(profile.id)
    } catch {
      breakdown = []
    }

    const totalGrants = breakdown.reduce((s, r) => s + (r.count || 0), 0)

    reports.push({
      profileId: profile.id,
      profileName: profile.display_name || profile.id,
      totalGrants,
      archivedInRun: runResults.archived.filter((g) => g.profile_id === profile.id).length,
      flaggedStaleInRun: runResults.flagged.filter((g) => g.profile_id === profile.id).length,
      newCyclesInRun: runResults.newCycles.filter((g) => g.profile_id === profile.id).length,
      statusBreakdown: breakdown,
    })
  }

  return reports.filter((r) => r.totalGrants > 0)
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the full pipeline lifecycle maintenance pass.
 *
 * @param {Object} db - DB instance
 * @returns {{ archived: number, flaggedStale: number, newCyclesDetected: number, report: ProfileReport[] }}
 */
export async function runPipelineLifecycle(db) {
  if (!db) {
    return { archived: 0, flaggedStale: 0, newCyclesDetected: 0, report: [] }
  }

  const archiveResult = await archiveExpiredGrants(db)
  const staleResult = await flagStaleDiscoveries(db)
  const cycleResult = await detectNewCycles(db)

  const runResults = {
    archived: archiveResult.archived,
    flagged: staleResult.flagged,
    newCycles: cycleResult.newCycles,
  }

  const report = await buildProfileReports(db, runResults)

  return {
    archived: archiveResult.archived.length,
    flaggedStale: staleResult.flagged.length,
    newCyclesDetected: cycleResult.newCycles.length,
    report,
  }
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/pipelineLifecycleService.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('pipelineLifecycleService')
) {
  // Dynamic import to avoid loading DB in non-standalone contexts
  const { createRequire } = await import('module') // removed — createRequire is not used anywhere below; delete this line entirely
  const require = createRequire(import.meta.url)

  let db
  try {
    // Try to load the app's database connection
    const dbModule = await import('../db/database.js')
    db = dbModule.default || dbModule.db
  } catch {
    log.error('Could not load database. Exiting.')
    process.exit(1)
  }

  log.info('=== Pipeline Lifecycle Service ===')
  const result = await runPipelineLifecycle(db)
  log.info(`Archived expired grants:    ${result.archived}`)
  log.info(`Flagged stale discoveries:  ${result.flaggedStale}`)
  log.info(`New cycles detected:        ${result.newCyclesDetected}`)
  log.info(`\nProfile reports (${result.report.length} profiles with grants):`)
  result.report.slice(0, 10).forEach((r) =>
    log.info(
      `  ${r.profileName}: ${r.totalGrants} total, ` +
        `${r.archivedInRun} archived, ${r.flaggedStaleInRun} stale, ${r.newCyclesInRun} new cycles`,
    ),
  )
}
