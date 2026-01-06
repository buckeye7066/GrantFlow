import path from 'path'
import { promises as fs } from 'fs'

const REPO_ROOT = path.resolve(process.cwd())

/**
 * Create audit log entry for autonomous crawler operations
 */
async function auditLog(entry) {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  await fs.mkdir(auditDir, { recursive: true })
  
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    ...entry,
  }
  
  const logFile = path.join(auditDir, 'autonomous-crawlers.log')
  const logLine = JSON.stringify(logEntry) + '\n'
  
  try {
    await fs.appendFile(logFile, logLine, 'utf8')
  } catch (error) {
    console.error('[auditLog] Failed to write audit log:', error)
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

  await auditLog({
    action: 'autonomous_crawlers_start',
    options,
  })

  try {
    // Get profiles to process
    let profiles
    if (profileIds && Array.isArray(profileIds) && profileIds.length > 0) {
      const placeholders = profileIds.map(() => '?').join(',')
      profiles = db
        .prepare(`SELECT id, display_name, status FROM profiles WHERE id IN (${placeholders})`)
        .all(...profileIds)
    } else {
      // Get all active profiles
      profiles = db
        .prepare(`SELECT id, display_name, status FROM profiles WHERE status = 'active'`)
        .all()
    }

    report.profiles_processed = profiles.length

    // Create crawler jobs for each profile
    for (const profile of profiles) {
      for (const crawlerType of crawlerTypes) {
        try {
          const jobId = Math.random().toString(36).substring(2, 15)
          const parameters = {
            autonomous_run: true,
            profile_id: profile.id,
          }

          db.prepare(
            `
            INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
            VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
            `
          ).run(jobId, crawlerType, profile.id, JSON.stringify(parameters))

          report.jobs_created++
          report.jobs.push({
            job_id: jobId,
            profile_id: profile.id,
            profile_name: profile.display_name,
            crawler_type: crawlerType,
            status: 'queued',
          })

          await auditLog({
            action: 'crawler_job_created',
            job_id: jobId,
            profile_id: profile.id,
            crawler_type: crawlerType,
          })
        } catch (error) {
          report.errors.push({
            profile_id: profile.id,
            crawler_type: crawlerType,
            error: error.message,
          })
        }
      }
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
        const jobs = db
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
          const retriesUsed = db
            .prepare(`SELECT retry_count FROM crawler_jobs WHERE id = ?`)
            .get(failedJob.job_id)?.retry_count || 0

          if (retriesUsed < maxRetries) {
            try {
              const newJobId = Math.random().toString(36).substring(2, 15)
              const parameters = {
                autonomous_run: true,
                profile_id: failedJob.profile_id,
                retried_from_job_id: failedJob.job_id,
              }

              db.prepare(
                `
                INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
                VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
                `
              ).run(newJobId, failedJob.crawler_type, failedJob.profile_id, JSON.stringify(parameters))

              db.prepare(
                `
                UPDATE crawler_jobs
                SET retry_count = COALESCE(retry_count, 0) + 1,
                    last_retry_at = CURRENT_TIMESTAMP
                WHERE id = ?
                `
              ).run(failedJob.job_id)

              report.jobs_retried++
              failedJob.retry_job_id = newJobId

              await auditLog({
                action: 'crawler_job_retried',
                original_job_id: failedJob.job_id,
                new_job_id: newJobId,
                retry_count: retriesUsed + 1,
              })
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

    await auditLog({
      action: 'autonomous_crawlers_complete',
      report,
    })

    return report
  } catch (error) {
    await auditLog({
      action: 'autonomous_crawlers_error',
      error: error.message,
    })
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
    const opportunities = db.prepare(
      `
      SELECT * FROM funding_opportunities
      WHERE created_at >= datetime('now', '-1 hour')
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
export async function getAutonomousCrawlersStatus() {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  const logFile = path.join(auditDir, 'autonomous-crawlers.log')
  
  try {
    const content = await fs.readFile(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    const recentLogs = lines.slice(-30).map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    const lastRun = recentLogs.reverse().find(log => log.action === 'autonomous_crawlers_complete')

    return {
      last_run: lastRun || null,
      recent_operations: recentLogs.length,
      audit_log_path: path.relative(REPO_ROOT, logFile),
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        last_run: null,
        recent_operations: 0,
        message: 'No autonomous crawler operations have been run yet',
      }
    }
    throw error
  }
}
