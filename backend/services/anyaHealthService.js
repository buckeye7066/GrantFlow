/**
 * Anya Background Health Service
 *
 * Runs periodic health checks every ANYA_HEALTH_INTERVAL_MS (default: 30 min).
 * Each check is independent and errors are caught so the service never crashes the server.
 *
 * Tasks:
 *  1. Expire stale opportunities  — past-deadline records → is_active = false
 *  2. Detect profile bleed        — global catalog entries duplicating profile-scoped records
 *  3. Clean orphaned crawlers     — stuck crawler jobs older than 2 h → failed
 *  4. Audit profile signals       — flag profiles missing state/type fields
 *  5. Deduplicate opportunities   — merge exact title+sponsor+state duplicates
 */

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

let _db = null
let _intervalId = null
let _lastReport = null
let _running = false

// ── individual task runners ──────────────────────────────────────────────────

/**
 * Task 1: Mark opportunities with past deadlines as inactive.
 */
async function expireStaleOpportunities(db) {
  try {
    const isPostgres = db?.dialect === 'postgres'
    const falseVal = isPostgres ? 'FALSE' : '0'
    const trueVal = isPostgres ? 'TRUE' : '1'
    const nowExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"

    const result = db
      .prepare(
        `UPDATE funding_opportunities
            SET is_active = ${falseVal}, updated_at = CURRENT_TIMESTAMP
          WHERE is_active = ${trueVal}
            AND deadline IS NOT NULL
            AND deadline < ${nowExpr}
            AND (deadline_type IS NULL OR deadline_type NOT IN ('rolling', 'ongoing'))`,
      )
      .run()
    return { expired: result.changes ?? 0 }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Task 2: Detect profile bleed — global catalog entries that are exact duplicates
 * of profile-scoped records (same title + sponsor). These are artifacts from the
 * removed Phase 4 global sync in anyaStartupOperations.js.
 */
async function detectProfileBleed(db) {
  try {
    const rows = db
      .prepare(
        `SELECT g.id, g.title, g.sponsor
           FROM funding_opportunities g
          WHERE g.profile_id IS NULL
            AND g.sponsor IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM funding_opportunities p
               WHERE p.profile_id IS NOT NULL
                 AND p.title = g.title
                 AND p.sponsor IS NOT NULL
                 AND p.sponsor = g.sponsor
            )`,
      )
      .all()
    return { count: rows.length, samples: rows.slice(0, 5) }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Task 3: Mark crawler jobs that have been running for more than 2 hours as failed.
 */
async function cleanOrphanedCrawlers(db) {
  try {
    const isPostgres = db?.dialect === 'postgres'
    const twoHoursAgo = isPostgres
      ? "(NOW() - INTERVAL '2 hours')"
      : "datetime('now', '-2 hours')"

    const result = db
      .prepare(
        `UPDATE crawler_jobs
            SET status = 'failed',
                error = 'Marked failed by health service: job exceeded 2-hour timeout',
                updated_at = CURRENT_TIMESTAMP
          WHERE status = 'running'
            AND started_at < ${twoHoursAgo}`,
      )
      .run()
    return { cleaned: result.changes ?? 0 }
  } catch (err) {
    // crawler_jobs table may not exist in all deployments — treat as non-fatal
    return { error: err.message }
  }
}

/**
 * Task 4: Audit profiles for missing state/type signals required for matching.
 */
async function auditProfileSignals(db) {
  try {
    const missing = db
      .prepare(
        `SELECT id, display_name
           FROM profiles
          WHERE status = 'active'
            AND (state IS NULL OR state = '' OR profile_type IS NULL OR profile_type = '')`,
      )
      .all()
    return { profiles_missing_signals: missing.length, samples: missing.slice(0, 5) }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Task 5: Deduplicate global catalog entries with the same title + sponsor + state.
 * Keeps the most recently updated record and marks the rest inactive.
 */
async function deduplicateOpportunities(db) {
  try {
    const isPostgres = db?.dialect === 'postgres'
    const falseVal = isPostgres ? 'FALSE' : '0'
    const trueVal = isPostgres ? 'TRUE' : '1'

    // Find duplicate groups in the global catalog (profile_id IS NULL)
    const dupes = db
      .prepare(
        `SELECT title, sponsor, state, COUNT(*) AS cnt
           FROM funding_opportunities
          WHERE profile_id IS NULL
            AND is_active = ${trueVal}
          GROUP BY title, sponsor, state
         HAVING COUNT(*) > 1`,
      )
      .all()

    let deduped = 0
    for (const group of dupes) {
      // Keep the most recently updated record; mark the rest inactive
      const candidates = db
        .prepare(
          `SELECT id FROM funding_opportunities
            WHERE profile_id IS NULL
              AND title = ?
              AND (sponsor IS NULL AND ? IS NULL OR sponsor = ?)
              AND (state IS NULL AND ? IS NULL OR state = ?)
            ORDER BY updated_at DESC`,
        )
        .all(group.title, group.sponsor, group.sponsor, group.state, group.state)

      // Skip the first (newest); deactivate the rest
      for (let i = 1; i < candidates.length; i++) {
        db.prepare(
          `UPDATE funding_opportunities
              SET is_active = ${falseVal}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        ).run(candidates[i].id)
        deduped++
      }
    }

    return { deduped, groups_found: dupes.length }
  } catch (err) {
    return { error: err.message }
  }
}

// ── main health check runner ─────────────────────────────────────────────────

export async function runHealthCheck(db) {
  if (_running) {
    console.log('[AnyaHealth] Skipping — previous check still running')
    return _lastReport
  }

  _running = true
  const startTime = Date.now()
  console.log('[AnyaHealth] Starting health check...')

  const report = {
    started_at: new Date().toISOString(),
    expire_stale: null,
    profile_bleed_check: null,
    orphaned_crawlers: null,
    profile_signals_audit: null,
    deduplication: null,
    errors: [],
    duration_ms: 0,
  }

  try {
    report.expire_stale = await expireStaleOpportunities(db)
    if (report.expire_stale?.error) report.errors.push({ task: 'expire_stale', error: report.expire_stale.error })
  } catch (err) {
    report.errors.push({ task: 'expire_stale', error: err.message })
  }

  try {
    report.profile_bleed_check = await detectProfileBleed(db)
    if (report.profile_bleed_check?.error) report.errors.push({ task: 'profile_bleed_check', error: report.profile_bleed_check.error })
  } catch (err) {
    report.errors.push({ task: 'profile_bleed_check', error: err.message })
  }

  try {
    report.orphaned_crawlers = await cleanOrphanedCrawlers(db)
    if (report.orphaned_crawlers?.error) report.errors.push({ task: 'orphaned_crawlers', error: report.orphaned_crawlers.error })
  } catch (err) {
    report.errors.push({ task: 'orphaned_crawlers', error: err.message })
  }

  try {
    report.profile_signals_audit = await auditProfileSignals(db)
    if (report.profile_signals_audit?.error) report.errors.push({ task: 'profile_signals_audit', error: report.profile_signals_audit.error })
  } catch (err) {
    report.errors.push({ task: 'profile_signals_audit', error: err.message })
  }

  try {
    report.deduplication = await deduplicateOpportunities(db)
    if (report.deduplication?.error) report.errors.push({ task: 'deduplication', error: report.deduplication.error })
  } catch (err) {
    report.errors.push({ task: 'deduplication', error: err.message })
  }

  report.duration_ms = Date.now() - startTime
  report.completed_at = new Date().toISOString()

  console.log(
    `[AnyaHealth] Check complete in ${report.duration_ms}ms — ` +
    `expired=${report.expire_stale?.expired ?? 'err'}, ` +
    `bleed=${report.profile_bleed_check?.count ?? 'err'}, ` +
    `orphaned_crawlers=${report.orphaned_crawlers?.cleaned ?? 'err'}, ` +
    `deduped=${report.deduplication?.deduped ?? 'err'}`,
  )

  _lastReport = report
  _running = false
  return report
}

// ── service lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the background health service.
 * Safe to call multiple times — only one interval will be registered.
 */
export function startHealthService(db) {
  if (_intervalId) return // already running

  _db = db
  const intervalMs = Number(process.env.ANYA_HEALTH_INTERVAL_MS) || DEFAULT_INTERVAL_MS

  console.log(`[AnyaHealth] Background service started (interval: ${intervalMs / 1000}s)`)

  // Run an initial check shortly after startup
  setTimeout(() => {
    runHealthCheck(_db).catch((err) => {
      console.error('[AnyaHealth] Initial check failed:', err?.message || err)
    })
  }, 60 * 1000) // 1-minute delay on startup

  _intervalId = setInterval(() => {
    runHealthCheck(_db).catch((err) => {
      console.error('[AnyaHealth] Scheduled check failed:', err?.message || err)
    })
  }, intervalMs)
}

/**
 * Stop the background health service.
 */
export function stopHealthService() {
  if (_intervalId) {
    clearInterval(_intervalId)
    _intervalId = null
    console.log('[AnyaHealth] Background service stopped')
  }
}

/**
 * Return the most recent health report (or null if no check has run yet).
 */
export function getLastHealthReport() {
  return _lastReport
}
