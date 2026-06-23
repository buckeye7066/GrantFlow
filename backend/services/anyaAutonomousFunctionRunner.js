import path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { createCrawlerJob } from './crawlerJobCreation.js'
import { runProfileDiscoveryLive } from './crawlerOsService.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { buildProfileContext } from './profileHelpers.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { RELEVANCE_FLOOR } from '../startup/enforceInvariants.js'
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
 * Run crawlers for all profiles or specific profiles
 * @param {Object} options
 * @param {Array<string>} options.profileIds - Specific profile IDs to run crawlers for (or null for all)
 * @param {Array<string>} options.crawlerTypes - Types of crawlers to run (default: all)
 * @param {number} options.maxRetries - Maximum retries for failed jobs (default: 3)
 * @param {boolean} options.waitForCompletion - Wait for jobs to complete (default: false)
 * @param {number} options.timeoutMinutes - Timeout for job completion in minutes (default: 30)
 * @param {number} options.matchThreshold - Match percentage threshold for profile pipeline (default: 55)
 * @param {boolean} options.saveAllToGlobal - Save all opportunities to global page (default: true)
 * @param {Object} context - Database and user context
 */
export async function runAutonomousCrawlers(options, context) {
  const {
    profileIds = null,
    // Note: 'national' deprecated; use 'comprehensive' with parameters.mode='geo' for Geo Crawl
    crawlerTypes = ['local', 'scholarship', 'curated_benefits', 'comprehensive', 'profile_enrichment'],
    maxRetries = 3,
    waitForCompletion = false,
    timeoutMinutes = 30,
    matchThreshold = 80,
    saveAllToGlobal = true,
  } = options

  const { db } = context

  if (!db) {
    throw new Error('Database connection unavailable')
  }

  // CUTOVER (2026-06-23): autonomous discovery runs through the Crawler OS, not
  // the retired legacy fleet. The legacy fleet was still firing on the Anya
  // autonomous schedule (~every 2h), enqueuing local/scholarship/curated_benefits/
  // comprehensive/profile_enrichment jobs that synthesized templated geo-stub junk
  // (89k inert local_directory_* rows) and fat per-job snapshots that grew
  // crawler_jobs to 8.3GB and triggered prod disk-full failures. The OS path
  // (runProfileDiscoveryLive) is the same engine Robert + /discover-all already use.
  // Set ANYA_AUTONOMOUS_LEGACY_FLEET=1 ONLY to temporarily resurrect the old fleet.
  if (process.env.ANYA_AUTONOMOUS_LEGACY_FLEET !== '1') {
    return runAutonomousCrawlersViaOs(options, context)
  }

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    crawler_types: crawlerTypes,
    max_retries: maxRetries,
    profiles_processed: 0,
    jobs_created: 0,
    jobs_completed: 0,
    jobs_failed: 0,
    jobs_retried: 0,
    errors: [],
    jobs: [],
  }

  await auditLog({ action: 'start', options }, context)

  try {
    // Get profiles to process
    let profiles
    if (profileIds && Array.isArray(profileIds) && profileIds.length > 0) {
      const placeholders = profileIds.map(() => '?').join(',')
      profiles = await db
        .prepare(`SELECT id, display_name, status FROM profiles WHERE id IN (${placeholders})`)
        .all(...profileIds)
    } else {
      // Get all active profiles
      profiles = await db
        .prepare(`SELECT id, display_name, status FROM profiles WHERE status = 'active'`)
        .all()
    }

    report.profiles_processed = profiles.length

    // Create crawler jobs for each profile (idempotent creation).
    const createdJobs = []
    
    for (const profile of profiles) {
      for (const crawlerType of crawlerTypes) {
        try {
          const parameters = {
            autonomous_run: true,
            profile_id: profile.id,
          }
          const created = await createCrawlerJob(db, {
            type: crawlerType,
            profileId: profile.id,
            organizationId: null,
            parameters,
            requestedBy: context?.user?.id ?? 'anya_autonomous',
            status: 'queued',
            buildSnapshot: false,
          })

          if (created?.existing) {
            report.jobs.push({
              job_id: created.jobId ?? created?.job?.id ?? null,
              profile_id: profile.id,
              profile_name: profile.display_name,
              crawler_type: crawlerType,
              status: 'skipped',
              skipped_reason: 'duplicate',
            })
            continue
          }

          const jobId = created.jobId
          report.jobs_created++
          report.jobs.push({
            job_id: jobId,
            profile_id: profile.id,
            profile_name: profile.display_name,
            crawler_type: crawlerType,
            status: 'queued',
          })
          
          // Track job for dispatch
          createdJobs.push({ jobId, crawlerType, profileId: profile.id })

          await auditLog(
            {
              action: 'crawler_job_created',
              job_id: jobId,
              profile_id: profile.id,
              crawler_type: crawlerType,
            },
            context,
          )
        } catch (error) {
          report.errors.push({
            profile_id: profile.id,
            crawler_type: crawlerType,
            error: error.message,
          })
        }
      }
    }
    
    // Dispatch all jobs asynchronously (fire and forget unless waitForCompletion)
    const dispatchPromises = createdJobs.map(({ jobId, crawlerType, profileId }) => {
      return dispatchCrawlerJob({
        db,
        jobId,
        uploadDir: context.uploadDir,
        getOpenAI: context.getOpenAI,
      }).catch(err => {
        console.error(`[autonomous] Job ${jobId} (${crawlerType}) dispatch failed:`, err)
        report.errors.push({
          job_id: jobId,
          profile_id: profileId,
          crawler_type: crawlerType,
          error: `Dispatch failed: ${err.message}`,
        })
      })
    })
    
    // If not waiting, let dispatches run in background.
    // NOTE: Retry logic and opportunity saving only run when waitForCompletion=true.
    // For background jobs, retries are handled by the crawler dispatcher itself.
    if (!waitForCompletion) {
      // Fire and forget - don't await
      Promise.all(dispatchPromises).catch(err => {
        console.error('[autonomous] Background dispatch batch error:', err)
      })

      // Quick status snapshot so callers don't see everything stuck in "queued".
      try {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const ids = report.jobs.map((j) => j.job_id)
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',')
          const rows = await db
            .prepare(`SELECT id, status, error FROM crawler_jobs WHERE id IN (${placeholders})`)
            .all(...ids)

          const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
          rows.forEach((row) => {
            const status = row?.status || 'queued'
            if (counts[status] === undefined) counts[status] = 0
            counts[status] += 1
            const reportJob = report.jobs.find((j) => j.job_id === row.id)
            if (reportJob) {
              reportJob.status = status
              if (row.error) reportJob.error = row.error
            }
          })

          report.initial_status_counts = counts
        }
      } catch (error) {
        report.initial_status_counts = { error: error?.message || String(error) }
      }
    } else {
      // Wait for initial dispatch to complete before monitoring
      await Promise.all(dispatchPromises)
    }

    // If waiting for completion, monitor jobs
    if (waitForCompletion) {
      const timeoutMs = timeoutMinutes * 60 * 1000
      const pollInterval = 10000 // 10 seconds
      const startWaitTime = Date.now()

      while (Date.now() - startWaitTime < timeoutMs) {
        // Check status of all jobs
        const jobIds = report.jobs.map(j => j.job_id)
        const placeholders = jobIds.map(() => '?').join(',')
        const jobs = await db
          .prepare(`SELECT id, status, error FROM crawler_jobs WHERE id IN (${placeholders})`)
          .all(...jobIds)

        const statusCounts = {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        }

        for (const job of jobs) {
          statusCounts[job.status] = (statusCounts[job.status] || 0) + 1
          
          // Update job status in report
          const reportJob = report.jobs.find(j => j.job_id === job.id)
          if (reportJob) {
            reportJob.status = job.status
            if (job.error) {
              reportJob.error = job.error
            }
          }
        }

        report.jobs_completed = statusCounts.completed
        report.jobs_failed = statusCounts.failed

        // Check if all jobs are done
        const pendingJobs = statusCounts.queued + statusCounts.running
        if (pendingJobs === 0) {
          break
        }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    // Process completed jobs to save opportunities
    if (report.jobs_completed > 0) {
      const completedJobs = report.jobs.filter(j => j.status === 'completed')
      
      for (const job of completedJobs) {
        try {
          // Save results to global opportunities if enabled
          if (saveAllToGlobal) {
            const saveResult = await saveCrawlerResultsToGlobal({ jobId: job.job_id }, context)
            job.global_save = saveResult
          }
          
          // Process opportunities for profile pipeline with match filtering
          if (matchThreshold > 0) {
            await saveHighMatchesToProfile({
              jobId: job.job_id,
              profileId: job.profile_id,
              matchThreshold,
            }, context)
            job.profile_save = { threshold: matchThreshold, status: 'completed' }
          }
        } catch (error) {
          report.errors.push({
            job_id: job.job_id,
            error: `Failed to save opportunities: ${error.message}`,
          })
        }
      }
    }

    // Handle failed jobs with retries
    if (report.jobs_failed > 0 && maxRetries > 0) {
        const failedJobs = report.jobs.filter(j => j.status === 'failed')
        
        for (const failedJob of failedJobs) {
          const retriesUsed = (await db
            .prepare(`SELECT retry_count FROM crawler_jobs WHERE id = ?`)
            .get(failedJob.job_id))?.retry_count || 0

          if (retriesUsed < maxRetries) {
            try {
              const newJobId = randomUUID()
              const parameters = {
                autonomous_run: true,
                profile_id: failedJob.profile_id,
                retried_from_job_id: failedJob.job_id,
              }

              await db.prepare(
                `
                INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
                VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
                `
              ).run(newJobId, failedJob.crawler_type, failedJob.profile_id, JSON.stringify(parameters))

              await db.prepare(
                `
                UPDATE crawler_jobs
                SET retry_count = COALESCE(retry_count, 0) + 1,
                    last_retry_at = CURRENT_TIMESTAMP
                WHERE id = ?
                `
              ).run(failedJob.job_id)

              report.jobs_retried++
              failedJob.retry_job_id = newJobId

              await auditLog(
                {
                  action: 'crawler_job_retried',
                  original_job_id: failedJob.job_id,
                  new_job_id: newJobId,
                  retry_count: retriesUsed + 1,
                },
                context,
              )
            } catch (error) {
              report.errors.push({
                job_id: failedJob.job_id,
                error: `Failed to retry: ${error.message}`,
              })
            }
          }
        }
      }
    }

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration

    await auditLog(
      {
        action: 'autonomous_crawlers_complete',
        report,
      },
      context,
    )

    return report
  } catch (error) {
    await auditLog(
      {
        action: 'autonomous_crawlers_error',
        error: error.message,
      },
      context,
    )
    throw error
  }
}

/**
 * Save opportunities with high match scores to profile pipeline
 * @param {Object} options
 * @param {string} options.jobId - Crawler job ID
 * @param {string} options.profileId - Profile ID
 * @param {number} options.matchThreshold - Minimum match percentage (0-100)
 * @param {Object} context - Database context
 */
async function saveHighMatchesToProfile(options, context) {
  const { jobId, profileId, matchThreshold } = options
  const { db } = context
  
  if (!db) {
    throw new Error('Database connection unavailable')
  }
  
  try {
    const thresholdNum = Number(matchThreshold)
    // Clamp the caller-supplied threshold into [RELEVANCE_FLOOR, 100]. Anya's
    // autonomous pipeline-save job must never persist below the canonical
    // pipeline relevance floor, even if a job is queued with a lower threshold
    // (the saver's own hard floor is the net behind this).
    const threshold = Number.isFinite(thresholdNum)
      ? Math.max(RELEVANCE_FLOOR, Math.min(100, thresholdNum))
      : Math.max(RELEVANCE_FLOOR, 55)

    // Get the crawler job
    const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    if (!job || job.status !== 'completed') {
      return { job_id: jobId, profile_id: profileId, message: 'Job not completed or not found' }
    }

    const parseJson = (value, fallback) => {
      try {
        return value && typeof value === 'string' ? JSON.parse(value) : (value ?? fallback)
      } catch {
        return fallback
      }
    }

    const jobParams = parseJson(job.parameters, {})

    // Job type -> opportunity source(s)
    const sourcesByJobType = {
      local: ['local_foundation'],
      scholarship: ['scholarship_crawler'],
      curated_benefits: ['curated_benefits'],
      health_resources: ['health_resources_crawler'],
      comprehensive: ['verified_real'],
      item_search: ['item_funding'],
      item_gift_search: ['item_gift'],
    }

    const sources = sourcesByJobType[job.type] || null

    // Build full profile context (sections + signals) for match scoring.
    const profileContext = await buildProfileContext(db, profileId)

    // Item crawlers are query-driven; boost match scoring with the item query terms.
    const itemQuery =
      typeof jobParams?.item === 'string'
        ? jobParams.item
        : typeof jobParams?.item_keywords === 'string'
          ? jobParams.item_keywords
          : typeof jobParams?.keywords === 'string'
            ? jobParams.keywords
            : null
    if (itemQuery) {
      const raw = String(itemQuery).trim().toLowerCase()
      const tokens = raw.split(/\s+/g).filter(Boolean)
      if (!profileContext.signals) profileContext.signals = {}
      if (!profileContext.signals.keywordSet) profileContext.signals.keywordSet = new Set()
      if (raw) profileContext.signals.keywordSet.add(raw)
      tokens.forEach((t) => profileContext.signals.keywordSet.add(t))
    }

    // Get opportunities created/updated during this job for this profile.
    // We scope by started_at to avoid accidentally pulling other profiles' results.
    const since = job.started_at || job.created_at || null
    // IMPORTANT:
    // - Many crawlers upsert globally-deduped opportunities (update existing rows).
    // - If we filter only by created_at >= job.started_at we will discard valid results.
    // Use (created_at OR updated_at) window.
    const sincePredicate =
      db?.dialect === 'postgres'
        ? `(created_at >= COALESCE(?, created_at) OR updated_at >= COALESCE(?, updated_at))`
        : `(created_at >= COALESCE(?, created_at) OR updated_at >= COALESCE(?, updated_at))`

    const sourceClause = Array.isArray(sources) && sources.length ? `AND source IN (${sources.map(() => '?').join(', ')})` : ''

    const opportunities = await db
      .prepare(
        `
          SELECT *
          FROM funding_opportunities
          WHERE (profile_id = ? OR profile_id IS NULL)
            AND ${sincePredicate}
            ${sourceClause}
          ORDER BY updated_at DESC
          LIMIT 2000
        `,
      )
      .all(profileId, since, since, ...(sources || []))

    let checked = 0
    let eligible = 0
    let saved = 0
    let below = 0
    let already = 0
    let errors = 0

    for (const opp of opportunities || []) {
      checked += 1
      try {
        const result = await saveToProfilePipeline(db, opp, profileId, profileContext, null, threshold)
        const matchPct = typeof result?.matchPercentage === 'number' ? result.matchPercentage : null
        if ((matchPct !== null && matchPct !== undefined) && matchPct >= threshold) eligible += 1

        if (result?.saved) {
          saved += 1
        } else if (String(result?.reason || '').toLowerCase().includes('already in pipeline')) {
          already += 1
        } else if ((matchPct !== null && matchPct !== undefined) && matchPct < threshold) {
          below += 1
        }
      } catch (e) {
        errors += 1
      }
    }

    // If we found opportunities but saved none, log why (failure-state visibility).
    if (checked > 0 && saved === 0) {
      log.info('[autonomous] no pipeline inserts for job', {
        job_id: jobId,
        profile_id: profileId,
        checked,
        eligible,
        already,
        below,
        threshold,
      })
    }

    return {
      job_id: jobId,
      profile_id: profileId,
      opportunities_checked: checked,
      eligible_count: eligible,
      saved_to_profile: saved,
      already_in_pipeline: already,
      below_threshold: below,
      errors,
      match_threshold: threshold,
    }
  } catch (error) {
    throw new Error(`Failed to save high matches to profile: ${error.message}`)
  }
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
