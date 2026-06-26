import path from 'path'
import { promises as fs } from 'fs'
import { runProfileDiscoveryLive } from './crawlerOsService.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { createLogger } from '../utils/logger.js'

// Parse a JSON-array column that may already be an array or a JSON string.
function parseJsonArrayColumn(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}
const log = createLogger('anyaAutonomousFunctionRunner')

const REPO_ROOT = path.resolve(process.cwd())

/**
 * Create audit log entry for autonomous crawler operations
 */
function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

async function auditLog(entry, context) {
  const db = context?.db
  if (db) {
    try {
      logAuditEvent(db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: `autonomous_crawlers.${String(entry?.action || 'event')}`,
        severity: SEVERITY.INFO,
        userId: context?.user?.userId ?? context?.user?.id ?? null,
        profileId: context?.profile_id ?? context?.profileId ?? null,
        resourceType: 'anya_autonomous_crawlers',
        resourceId: null,
        details: entry ?? null,
      })
      return
    } catch (error) {
      // fall through to platform logs
      console.warn('[anyaAutonomousFunctionRunner] audit db write failed:', error?.message || error)
    }
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  }

  // Durable fallback when DB is unavailable: platform logs.
  log.info('[audit][autonomous-crawlers]', JSON.stringify(logEntry))

  // Dev-only filesystem sink (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(auditDir, { recursive: true })
      const logFile = path.join(auditDir, 'autonomous-crawlers.log')
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
    } catch {
      // best-effort
    }
  }
}

/**
 * runAutonomousCrawlersViaOs — the Crawler-OS implementation of autonomous
 * discovery. For each in-scope profile it runs the canonical OS pipeline
 * (runProfileDiscoveryLive), which builds the thesis, plans relatable sources,
 * fetches them SSRF-safely, gates reality, persists opportunities + matches +
 * recommendations to the live tables, and (for individuals) runs the bounded
 * web-LLM scholarship pass. This REPLACES the retired legacy fleet
 * (local/scholarship/curated_benefits/comprehensive/profile_enrichment) which
 * synthesized templated geo-stub junk and fat per-job snapshots. Returns a report
 * shape compatible with the scheduler (profiles_processed/jobs_created/jobs_completed).
 */
async function runAutonomousCrawlersViaOs(options, context) {
  const { profileIds = null } = options || {}
  const { db } = context
  const startTime = Date.now()
  const report = {
    started_at: new Date(startTime).toISOString(),
    engine: 'crawler-os',
    crawler_types: ['crawler-os'],
    profiles_processed: 0,
    jobs_created: 0,
    jobs_completed: 0,
    jobs_failed: 0,
    jobs_retried: 0,
    opportunities_stored: 0,
    matches_created: 0,
    errors: [],
    jobs: [],
  }
  await auditLog({ action: 'start', engine: 'crawler-os', options }, context)

  let profiles
  if (profileIds && Array.isArray(profileIds) && profileIds.length > 0) {
    const placeholders = profileIds.map(() => '?').join(',')
    profiles = await db
      .prepare(`SELECT id, display_name, status FROM profiles WHERE id IN (${placeholders})`)
      .all(...profileIds)
  } else {
    profiles = await db
      .prepare(`SELECT id, display_name, status FROM profiles WHERE status = 'active'`)
      .all()
  }
  report.profiles_processed = profiles.length

  for (const profile of profiles) {
    try {
      const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: profile.id })
      if (run?.skipped) {
        report.jobs.push({
          profile_id: profile.id, profile_name: profile.display_name,
          engine: 'crawler-os', status: 'skipped', skipped_reason: run.reason || 'skipped',
        })
        continue
      }
      const stored = persisted?.opportunities ?? run?.stored ?? 0
      const matches = persisted?.matches ?? 0
      report.jobs_created++
      report.jobs_completed++
      report.opportunities_stored += stored
      report.matches_created += matches
      report.jobs.push({
        profile_id: profile.id, profile_name: profile.display_name,
        engine: 'crawler-os', status: 'completed', stored, matches,
      })
    } catch (error) {
      report.jobs_failed++
      report.errors.push({ profile_id: profile.id, error: error.message })
      report.jobs.push({
        profile_id: profile.id, profile_name: profile.display_name,
        engine: 'crawler-os', status: 'failed', error: error.message,
      })
    }
  }

  report.completed_at = new Date().toISOString()
  report.duration_seconds = Math.round((Date.now() - startTime) / 1000)
  await auditLog({
    action: 'complete', engine: 'crawler-os',
    summary: {
      profiles: report.profiles_processed, stored: report.opportunities_stored,
      matches: report.matches_created, failed: report.jobs_failed,
    },
  }, context)
  return report
}

/**
 * Run autonomous funding discovery through the Crawler OS only.
 * @param {Object} options
 * @param {Array<string>} options.profileIds - Specific profile IDs to run (or null for all active profiles)
 * @param {Object} context - Database and user context
 */
export async function runAutonomousCrawlers(options = {}, context = {}) {
  if (!context?.db) {
    throw new Error('Database connection unavailable')
  }
  return runAutonomousCrawlersViaOs(options, context)
}

/**
 * Ensure crawler results are saved to both profile-specific and global opportunities
 * This function should be called after a crawler completes
 * @param {Object} options
 * @param {string} options.jobId - Crawler job ID
 * @param {Object} context - Database context
 */
export async function saveCrawlerResultsToGlobal(options, context) {
  const { jobId } = options
  const { db } = context

  if (!db) {
    throw new Error('Database connection unavailable')
  }

  try {
    // Get the crawler job
    const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

    if (!job) {
      throw new Error('Job not found')
    }

    if (job.status !== 'completed') {
      const err = new Error(`Job ${jobId} exists but is not saveable yet (status: ${job.status || 'unknown'})`)
      err.status = 400
      err.details = { job_id: jobId, status: job.status || null }
      throw err
    }

    // Get all opportunities created or updated for this profile during this job
    const startedAt = job.started_at || job.created_at || '1970-01-01T00:00:00.000Z'
    const opportunities = await db
      .prepare(
        `
        SELECT * FROM funding_opportunities
        WHERE profile_id = ?
          AND (created_at >= ? OR updated_at >= ?)
        ORDER BY updated_at DESC
        `
      )
      .all(job.profile_id, startedAt, startedAt)

    let savedToGlobal = 0

    for (const opp of opportunities) {
      // Check if this opportunity already exists in global opportunities
      // We'll consider it a duplicate if title and sponsor match
      const existing = await db
        .prepare(
          `
          SELECT id FROM funding_opportunities
          WHERE title = ?
            AND sponsor = ?
            AND profile_id IS NULL
          LIMIT 1
          `
        )
        .get(opp.title, opp.sponsor)

      if (!existing) {
        // Create a global version (without profile_id) THROUGH the canonical
        // gated inserter (Mission System 1, RC-7). Promoting a profile-scoped
        // row into the global pool makes it globally user-visible, so it must
        // pass the reality gate + quality/policy/validation/reviewer gates and
        // canonical URL dedupe — previously this was a raw, un-gated INSERT.
        const res = await upsertFundingOpportunity(
          db,
          {
            title: opp.title,
            sponsor: opp.sponsor,
            deadline: opp.deadline,
            deadline_type: opp.deadline_type,
            amount_min: opp.amount_min,
            amount_max: opp.amount_max,
            amount_description: opp.amount_description,
            application_url: opp.application_url,
            source: opp.source,
            source_url: opp.source_url,
            evidence_url: opp.evidence_url || opp.source_url || opp.application_url,
            state: opp.state,
            is_national: opp.is_national,
            opportunity_type: opp.opportunity_type,
            funding_type: opp.funding_type,
            requires_match: opp.requires_match,
            requires_501c3: opp.requires_501c3,
            match_percentage: opp.match_percentage,
            is_loan: opp.is_loan,
            eligibility_bullets: parseJsonArrayColumn(opp.eligibility_bullets),
            categories: parseJsonArrayColumn(opp.categories),
            keywords: parseJsonArrayColumn(opp.keywords),
            record_origin: opp.record_origin,
            // Intentionally NO profile_id → this is the global row.
          },
          {},
        )

        if (res?.inserted) savedToGlobal++
      }
    }

    return {
      job_id: jobId,
      profile_id: job.profile_id,
      opportunities_found: opportunities.length,
      saved_to_global: savedToGlobal,
      message: `Saved ${savedToGlobal} new opportunities to global pool`,
    }
  } catch (error) {
    const wrapped = new Error(`Failed to save to global opportunities: ${error.message}`)
    if (error?.status) wrapped.status = error.status
    if (error?.details) wrapped.details = error.details
    throw wrapped
  }
}

/**
 * Get status of autonomous crawler operations
 */
export async function getAutonomousCrawlersStatus(db = null) {
  const base = {
    last_run: null,
    recent_operations: 0,
  }

  // Prefer durable DB audit logs when available.
  if (db) {
    try {
      const row = await db
        .prepare(
          `
            SELECT *
            FROM audit_logs
            WHERE category = ?
              AND action = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(AUDIT_CATEGORIES.ANYA, 'autonomous_crawlers.autonomous_crawlers_complete')

      if (row) {
        let details = null
        try {
          details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details
        } catch {
          details = row.details ?? null
        }
        base.last_run = details?.report ?? details ?? null
        base.recent_operations = 1
        base.audit_event_id = row.id
        base.created_at = row.created_at
      } else {
        base.message = 'No autonomous crawler operations have been run yet'
      }
    } catch (error) {
      base.audit_error = error?.message || String(error)
    }

    try {
      const rows = await db
        .prepare(
          `
            SELECT status, COUNT(*) as count
            FROM crawler_jobs
            GROUP BY status
          `,
        )
        .all()
      const byStatus = (rows || []).reduce((acc, row) => {
        acc[row.status] = Number(row.count || 0)
        return acc
      }, {})
      base.job_status_counts = {
        queued: byStatus.queued || 0,
        running: byStatus.running || 0,
        completed: byStatus.completed || 0,
        failed: byStatus.failed || 0,
        cancelled: byStatus.cancelled || 0,
      }
    } catch (error) {
      base.job_status_counts = { error: error?.message || String(error) }
    }

    return base
  }

  // Dev-only filesystem fallback (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
    const logFile = path.join(auditDir, 'autonomous-crawlers.log')
    try {
      const content = await fs.readFile(logFile, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)
      const recentLogs = lines
        .slice(-30)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      const lastRun = recentLogs.reverse().find((log) => log.action === 'autonomous_crawlers_complete')
      base.last_run = lastRun || null
      base.recent_operations = recentLogs.length
      base.audit_log_path = path.relative(REPO_ROOT, logFile)
      return base
    } catch (error) {
      if (error?.code !== 'ENOENT') base.audit_error = error?.message || String(error)
    }
  }

  base.message = 'No autonomous crawler operations have been run yet'
  return base
}
