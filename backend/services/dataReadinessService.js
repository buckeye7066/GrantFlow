/**
 * Data Readiness Service
 *
 * Checks whether the funding_opportunities catalog has enough data to produce
 * meaningful matches for profiles.  Returns one of four machine-readable
 * statuses that the UI and matching endpoints can consume:
 *
 *   not_run  – catalog is empty AND no crawl jobs are in progress/queued
 *   running  – catalog is empty but at least one crawl job is queued/running
 *   stale    – catalog has rows but none were crawled in the last STALE_DAYS days
 *   ready    – catalog has rows crawled within STALE_DAYS days
 *
 * The MINIMUM_OPPORTUNITY_COUNT threshold prevents a single stray row from
 * being treated as "ready".
 */

/**
 * Days after the last crawl before the catalog is considered stale.
 * Override with OPPORTUNITY_STALE_DAYS env var.
 */
const STALE_DAYS = Number.parseInt(process.env.OPPORTUNITY_STALE_DAYS || '7', 10)

/**
 * Minimum row count required to consider the catalog non-empty.
 * Override with OPPORTUNITY_MIN_COUNT env var.
 */
const MINIMUM_OPPORTUNITY_COUNT = Number.parseInt(process.env.OPPORTUNITY_MIN_COUNT || '5', 10)

/**
 * Return a data-readiness snapshot for the funding_opportunities catalog.
 *
 * @param {import('better-sqlite3').Database|object} db
 * @returns {Promise<{
 *   status: 'not_run'|'running'|'stale'|'ready',
 *   opportunity_count: number,
 *   last_crawled_iso: string|null,
 *   running_jobs: number,
 *   queued_jobs: number,
 *   stale_threshold_days: number,
 *   minimum_count: number,
 * }>}
 */
export async function getDataReadiness(db) {
  const result = {
    status: 'not_run',
    opportunity_count: 0,
    last_crawled_iso: null,
    running_jobs: 0,
    queued_jobs: 0,
    stale_threshold_days: STALE_DAYS,
    minimum_count: MINIMUM_OPPORTUNITY_COUNT,
  }

  if (!db) return result

  try {
    // Count live, active opportunities in the catalog.
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM funding_opportunities WHERE is_active = 1 OR is_active IS NULL`,
      )
      .get()
    result.opportunity_count = Number(countRow?.c ?? 0)

    // Most recent crawl timestamp across the catalog.
    const crawlRow = await db
      .prepare(
        `SELECT MAX(last_crawled) AS latest FROM funding_opportunities`,
      )
      .get()
    result.last_crawled_iso = crawlRow?.latest ?? null

    // Count crawler jobs that are currently running or queued.
    const runningRow = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) AS queued
         FROM crawler_jobs`,
      )
      .get()
    result.running_jobs = Number(runningRow?.running ?? 0)
    result.queued_jobs = Number(runningRow?.queued ?? 0)
  } catch (error) {
    // If the table doesn't exist yet (first boot before migration) treat as not_run.
    console.warn('[dataReadinessService] Failed to query data readiness:', error?.message || String(error))
    return result
  }

  const hasEnoughData = result.opportunity_count >= MINIMUM_OPPORTUNITY_COUNT
  const hasActiveJobs = result.running_jobs > 0 || result.queued_jobs > 0

  if (!hasEnoughData) {
    result.status = hasActiveJobs ? 'running' : 'not_run'
    return result
  }

  // Catalog has data — check freshness.
  if (result.last_crawled_iso) {
    const lastCrawledMs = new Date(result.last_crawled_iso).getTime()
    const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000
    if (!Number.isNaN(lastCrawledMs) && Date.now() - lastCrawledMs > staleMs) {
      result.status = 'stale'
      return result
    }
  }

  result.status = 'ready'
  return result
}

/**
 * Return alert conditions based on data readiness and job queue health.
 *
 * @param {object} db
 * @returns {Promise<{
 *   alerts: Array<{ code: string, severity: 'critical'|'warning'|'info', message: string }>,
 *   healthy: boolean,
 * }>}
 */
export async function getSystemAlerts(db) {
  const alerts = []

  if (!db) {
    return {
      alerts: [{ code: 'db_unavailable', severity: 'critical', message: 'Database connection is unavailable.' }],
      healthy: false,
    }
  }

  try {
    const readiness = await getDataReadiness(db)

    if (readiness.status === 'not_run') {
      alerts.push({
        code: 'catalog_empty',
        severity: 'critical',
        message: 'No funding opportunities in the catalog. Run a geo/national crawl to populate.',
      })
    } else if (readiness.status === 'stale') {
      alerts.push({
        code: 'catalog_stale',
        severity: 'warning',
        message: `Funding catalog last crawled ${readiness.last_crawled_iso ?? 'unknown'}. Re-run crawls to refresh.`,
      })
    }

    // Detect jobs stuck in 'running' state longer than the job timeout.
    // Uses CRAWLER_JOB_TIMEOUT_MS (default 30 min) as the threshold.
    const timeoutMs = Number.parseInt(process.env.CRAWLER_JOB_TIMEOUT_MS || String(30 * 60 * 1000), 10)
    const stuckThresholdMs = Math.max(timeoutMs, 5 * 60 * 1000) // at least 5 min
    const stuckCutoff = new Date(Date.now() - stuckThresholdMs).toISOString()

    const stuckRow = await db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM crawler_jobs
         WHERE status = 'running'
           AND started_at < ?`,
      )
      .get(stuckCutoff)
    const stuckCount = Number(stuckRow?.c ?? 0)
    if (stuckCount > 0) {
      alerts.push({
        code: 'jobs_stuck',
        severity: 'warning',
        message: `${stuckCount} crawler job(s) have been running for more than ${Math.round(stuckThresholdMs / 60000)} minutes.`,
      })
    }

    // Large queued backlog is a sign of dispatcher degradation.
    const QUEUE_BACKLOG_THRESHOLD = Number.parseInt(process.env.ALERT_QUEUE_BACKLOG_THRESHOLD || '20', 10)
    if (readiness.queued_jobs > QUEUE_BACKLOG_THRESHOLD) {
      alerts.push({
        code: 'queue_backlog',
        severity: 'warning',
        message: `${readiness.queued_jobs} jobs queued (threshold ${QUEUE_BACKLOG_THRESHOLD}). Check dispatcher health.`,
      })
    }

    // Recent crawler failures.
    const failureWindowH = 1 // look back 1 hour
    const failureCutoff = new Date(Date.now() - failureWindowH * 60 * 60 * 1000).toISOString()
    const failureRow = await db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM crawler_jobs
         WHERE status = 'failed'
           AND completed_at >= ?`,
      )
      .get(failureCutoff)
    const recentFailures = Number(failureRow?.c ?? 0)
    const FAILURE_ALERT_THRESHOLD = Number.parseInt(process.env.ALERT_FAILURE_THRESHOLD || '5', 10)
    if (recentFailures >= FAILURE_ALERT_THRESHOLD) {
      alerts.push({
        code: 'crawler_errors',
        severity: 'warning',
        message: `${recentFailures} crawler job(s) failed in the last ${failureWindowH}h (threshold ${FAILURE_ALERT_THRESHOLD}).`,
      })
    }
  } catch (error) {
    alerts.push({
      code: 'alert_check_failed',
      severity: 'critical',
      message: `Alert check failed: ${error?.message || String(error)}`,
    })
  }

  return {
    alerts,
    healthy: alerts.every((a) => a.severity !== 'critical'),
  }
}
