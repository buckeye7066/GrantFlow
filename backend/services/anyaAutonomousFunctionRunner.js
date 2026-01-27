import path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { enqueueCrawlerJobWithPolicy } from './jobs/enqueueJob.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

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
  console.log('[audit][autonomous-crawlers]', JSON.stringify(logEntry))

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
 * Run crawlers for all profiles or specific profiles
 * @param {Object} options
 * @param {Array<string>} options.profileIds - Specific profile IDs to run crawlers for (or null for all)
 * @param {Array<string>} options.crawlerTypes - Types of crawlers to run (default: all)
 * @param {number} options.maxRetries - Maximum retries for failed jobs (default: 3)
 * @param {boolean} options.waitForCompletion - Wait for jobs to complete (default: false)
 * @param {number} options.timeoutMinutes - Timeout for job completion in minutes (default: 30)
 * @param {number} options.matchThreshold - Match percentage threshold for profile pipeline (default: 80)
 * @param {boolean} options.saveAllToGlobal - Save all opportunities to global page (default: true)
 * @param {Object} context - Database and user context
 */
export async function runAutonomousCrawlers(options, context) {
  const {
    profileIds = null,
    // Note: 'national' deprecated; use 'comprehensive' with parameters.mode='geo' for Geo Crawl
    crawlerTypes = ['local', 'scholarship', 'comprehensive', 'profile_enrichment'],
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

    // Create crawler jobs for each profile (policy-backed; admin context).
    const createdJobs = []
    
    for (const profile of profiles) {
      for (const crawlerType of crawlerTypes) {
        try {
          const parameters = {
            autonomous_run: true,
            profile_id: profile.id,
          }
          const decision = await enqueueCrawlerJobWithPolicy({
            db,
            ctx: { isAdmin: true, userId: context?.user?.id ?? 'anya' },
            type: crawlerType,
            profileId: profile.id,
            organizationId: null,
            parameters,
            requestedBy: 'anya_autonomous',
            force: false,
            origin: 'anya.autonomous.crawlers',
            ip: null,
            userAgent: null,
          })

          // Policy may dedupe / skip; keep visibility either way.
          if (!decision.accepted) {
            report.jobs.push({
              job_id: decision.existing_job_id ?? null,
              profile_id: profile.id,
              profile_name: profile.display_name,
              crawler_type: crawlerType,
              status: 'skipped',
              skipped_reason: decision.reason,
            })
            continue
          }

          const jobId = decision.job_id
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
    
    // If not waiting, let dispatches run in background
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
 * Calculate match score between opportunity and profile
 */
function calculateMatchScore(opp, profile) {
  let score = 0
  let maxScore = 0
  
  // Location match (30 points)
  maxScore += 30
  if (opp.state && profile.state) {
    if (opp.state.toLowerCase() === profile.state.toLowerCase()) {
      score += 30
    } else if (opp.state === 'nationwide' || opp.is_national) {
      score += 15
    }
  } else if (opp.state === 'nationwide' || opp.is_national) {
    score += 15
  }
  
  // Category match (40 points)
  maxScore += 40
  if (opp.categories && profile.categories) {
    try {
      const oppCategories = JSON.parse(opp.categories)
      const profileCategories = JSON.parse(profile.categories)
      
      if (Array.isArray(oppCategories) && Array.isArray(profileCategories)) {
        const matches = oppCategories.filter(c => 
          profileCategories.some(pc => 
            c.toLowerCase().includes(pc.toLowerCase()) || 
            pc.toLowerCase().includes(c.toLowerCase())
          )
        )
        score += Math.min(40, matches.length * 10)
      }
    } catch (e) {
      // Ignore JSON parse errors
    }
  }
  
  // Organization type match (20 points)
  maxScore += 20
  if (opp.eligibility_bullets && profile.organization_type) {
    try {
      const eligibility = JSON.parse(opp.eligibility_bullets)
      if (Array.isArray(eligibility)) {
        const hasMatch = eligibility.some(e => 
          e.toLowerCase().includes(profile.organization_type.toLowerCase())
        )
        if (hasMatch) score += 20
      }
    } catch (e) {
      // Ignore JSON parse errors
    }
  }
  
  // Special attributes (10 points)
  maxScore += 10
  if (profile.serves_veterans && opp.keywords) {
    try {
      const keywords = JSON.parse(opp.keywords)
      if (Array.isArray(keywords) && keywords.some(k => k.toLowerCase().includes('veteran'))) {
        score += 5
      }
    } catch (e) {
      // Ignore
    }
  }
  if (profile.serves_disabled && opp.keywords) {
    try {
      const keywords = JSON.parse(opp.keywords)
      if (Array.isArray(keywords) && keywords.some(k => k.toLowerCase().includes('disabilit'))) {
        score += 5
      }
    } catch (e) {
      // Ignore
    }
  }
  
  return maxScore > 0 ? Math.round((score / maxScore) * 100) : 0
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
    // Get the profile
    const profile = db.prepare(
      'SELECT * FROM profiles WHERE id = ?'
    ).get(profileId)
    
    if (!profile) {
      throw new Error('Profile not found')
    }
    
    // Get the crawler job
    const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    
    if (!job || job.status !== 'completed') {
      return { message: 'Job not completed or not found' }
    }
    
    // Get opportunities from this job (we'll need to track them somehow)
    // For now, get recent opportunities
    const since1hPredicate =
      db?.dialect === 'postgres'
        ? `created_at >= (NOW() - INTERVAL '1 hour')`
        : `created_at >= datetime('now', '-1 hour')`

    const opportunities = db.prepare(
      `
      SELECT * FROM funding_opportunities
      WHERE ${since1hPredicate}
        AND (profile_id = ? OR profile_id IS NULL)
      ORDER BY created_at DESC
      LIMIT 100
      `
    ).all(profileId)
    
    let savedToProfile = 0
    let highMatchCount = 0
    
    for (const opp of opportunities) {
      const matchScore = calculateMatchScore(opp, profile)
      
      if (matchScore >= matchThreshold) {
        highMatchCount++
        
        // Check if already in profile pipeline
        const existing = db.prepare(
          'SELECT id FROM funding_opportunities WHERE title = ? AND sponsor = ? AND profile_id = ?'
        ).get(opp.title, opp.sponsor, profileId)
        
        if (!existing) {
          // Add to profile pipeline with match score
          const pipelineId = Math.random().toString(36).substring(2, 15)
          
          const matchReasons = []
          if (opp.state === profile.state) matchReasons.push('Location match')
          if (matchScore >= 90) matchReasons.push('Excellent category alignment')
          else if (matchScore >= 80) matchReasons.push('Strong category alignment')
          
          db.prepare(
            `
            INSERT INTO funding_opportunities (
              id, title, sponsor, deadline, amount_min, amount_max, amount_description,
              application_url, state, opportunity_type, requires_match, match_percentage,
              eligibility_bullets, categories, source, source_url, is_active,
              profile_id, match_score, match_reasons, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `
          ).run(
            pipelineId,
            opp.title,
            opp.sponsor,
            opp.deadline,
            opp.amount_min,
            opp.amount_max,
            opp.amount_description,
            opp.application_url,
            opp.state,
            opp.opportunity_type,
            opp.requires_match,
            opp.match_percentage,
            opp.eligibility_bullets,
            opp.categories,
            opp.source,
            opp.source_url,
            profileId,
            matchScore,
            JSON.stringify(matchReasons)
          )
          
          savedToProfile++
        }
      }
    }
    
    return {
      job_id: jobId,
      profile_id: profileId,
      opportunities_checked: opportunities.length,
      high_match_count: highMatchCount,
      saved_to_profile: savedToProfile,
      match_threshold: matchThreshold,
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
    const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    
    if (!job) {
      throw new Error('Job not found')
    }

    if (job.status !== 'completed') {
      return { message: 'Job not completed, skipping global save' }
    }

    // Get all opportunities created for this profile during this job
    // This assumes opportunities have a created_at timestamp we can use
    const opportunities = db
      .prepare(
        `
        SELECT * FROM funding_opportunities
        WHERE profile_id = ?
          AND created_at >= ?
        ORDER BY created_at DESC
        `
      )
      .all(job.profile_id, job.started_at)

    let savedToGlobal = 0

    for (const opp of opportunities) {
      // Check if this opportunity already exists in global opportunities
      // We'll consider it a duplicate if title and sponsor match
      const existing = db
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
        // Create a global version (without profile_id)
        const globalId = Math.random().toString(36).substring(2, 15)
        
        db.prepare(
          `
          INSERT INTO funding_opportunities (
            id, title, sponsor, deadline, amount_min, amount_max, amount_description,
            application_url, state, opportunity_type, requires_match, match_percentage,
            eligibility_bullets, categories, source, source_url, is_active,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `
        ).run(
          globalId,
          opp.title,
          opp.sponsor,
          opp.deadline,
          opp.amount_min,
          opp.amount_max,
          opp.amount_description,
          opp.application_url,
          opp.state,
          opp.opportunity_type,
          opp.requires_match,
          opp.match_percentage,
          opp.eligibility_bullets,
          opp.categories,
          opp.source,
          opp.source_url
        )

        savedToGlobal++
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
    throw new Error(`Failed to save to global opportunities: ${error.message}`)
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
