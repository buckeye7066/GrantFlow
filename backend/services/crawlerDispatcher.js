import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { processAvatarLookupJob } from './avatarCrawler.js'
import { processLocalCrawlerJob } from './localCrawler.js'
import { processScholarshipCrawlerJob } from './scholarshipCrawler.js'
import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { processItemCrawlerJob } from './itemCrawler.js'
import { processDocumentIngestionJob } from './documentIngestion.js'
import { processPipelineAutomationJob } from './pipelineAutomation.js'
import { buildProfileContext } from './profileHelpers.js'
import { processProfileEnrichmentJob } from './profileEnrichment.js'
import { processNationalJob } from './nationalJobRouter.js'
import { logFailedJob, determineSeverity } from './deadLetterQueue.js'
import { acquireCrawlerLock } from './crawlerConcurrencyGuard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const dataDir = join(__dirname, '..', 'data', 'crawlers')

const HANDLERS = {
  avatar_lookup: processAvatarLookupJob,
  local: processLocalCrawlerJob,
  scholarship: processScholarshipCrawlerJob,
  comprehensive: processComprehensiveCrawlerJob,
  national: processNationalJob,
  item_search: processItemCrawlerJob,
  document_ingest: processDocumentIngestionJob,
  pipeline_automation: processPipelineAutomationJob,
  profile_enrichment: processProfileEnrichmentJob,
}

function parseJSON(value) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[crawlerDispatcher] Failed to parse parameters JSON', error)
    return {}
  }
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function getMaxGlobalConcurrency() {
  return clampInt(process.env.CRAWLER_MAX_CONCURRENCY, { min: 1, max: 50, fallback: 6 })
}

function getDispatchMaxAttempts() {
  return clampInt(process.env.CRAWLER_DISPATCH_MAX_ATTEMPTS, { min: 1, max: 200, fallback: 30 })
}

function computeBackoffMs(attempt) {
  const base = clampInt(process.env.CRAWLER_DISPATCH_BASE_DELAY_MS, { min: 250, max: 60_000, fallback: 1_500 })
  const cap = clampInt(process.env.CRAWLER_DISPATCH_MAX_DELAY_MS, { min: 1_000, max: 10 * 60_000, fallback: 60_000 })
  const exp = Math.min(16, Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(cap, base * (2 ** exp) + jitter)
}

export function dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }) {
  const handle = async () => {
    const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ? LIMIT 1').get(jobId)
    if (!job) {
      console.warn('[crawlerDispatcher] Job not found', jobId)
      return
    }

    if (job.status && job.status !== 'queued') {
      return
    }
    
    // Check concurrency limits before starting job
    if (job.profile_id) {
      const lockResult = await acquireCrawlerLock(db, job.profile_id, job.type, { jobId })
      if (!lockResult.allowed) {
        console.warn('[crawlerDispatcher] Concurrency limit reached', {
          jobId,
          profileId: job.profile_id,
          reason: lockResult.reason,
          existingJobId: lockResult.existingJobId ?? null,
          runningCount: lockResult.runningCount ?? null,
          limit: lockResult.limit ?? null,
        })

        // IMPORTANT: This is expected behavior, not a "failure".
        // Do NOT mark the job failed (it pollutes diagnostics and blocks queues).
        // Instead keep it queued and retry shortly.
        try {
          await db
            .prepare(
              `
                UPDATE crawler_jobs
                SET error = NULL
                WHERE id = ?
                  AND status = 'queued'
              `,
            )
            .run(jobId)
        } catch {
          // ignore best-effort cleanup
        }

        setTimeout(() => {
          dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(() => {})
        }, 12_000)

        return
      }
    }

    // If a previous dispatcher pass scheduled this job in the future, respect it.
    if (job.next_dispatch_at) {
      const nextAt = new Date(job.next_dispatch_at)
      if (!Number.isNaN(nextAt.getTime())) {
        const waitMs = nextAt.getTime() - Date.now()
        if (waitMs > 250) {
          setTimeout(() => {
            dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(() => {})
          }, Math.min(waitMs, 60_000))
          return
        }
      }
    }

    const handler = HANDLERS[job.type]
    if (!handler) {
      const errorMsg = `Unhandled crawler type "${job.type}"`
      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
      `).run(errorMsg, jobId)
      
      // Log to dead letter queue
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error: errorMsg,
        jobParameters: parseJSON(job.parameters),
        severity: 'high',
      })
      return
    }

    const maxGlobalConcurrency = getMaxGlobalConcurrency()

    // Concurrency control (per-profile):
    // If a profile-scoped job is queued while another job for that profile is already running,
    // do NOT fail the job (that pollutes diagnostics). Instead keep it queued and retry soon.
    const profileId = job.profile_id ?? null
    const startSql = profileId
      ? `
          UPDATE crawler_jobs
          SET status = 'running',
              started_at = CURRENT_TIMESTAMP,
              error = NULL,
              parameters = COALESCE(parameters, '{}'),
              next_dispatch_at = NULL
          WHERE id = ?
            AND status = 'queued'
            AND (SELECT COUNT(*) FROM crawler_jobs WHERE status = 'running') < ?
            AND NOT EXISTS (
              SELECT 1
              FROM crawler_jobs
              WHERE profile_id = ?
                AND status = 'running'
                AND id <> ?
            )
        `
      : `
          UPDATE crawler_jobs
          SET status = 'running',
              started_at = CURRENT_TIMESTAMP,
              error = NULL,
              parameters = COALESCE(parameters, '{}'),
              next_dispatch_at = NULL
          WHERE id = ?
            AND status = 'queued'
            AND (SELECT COUNT(*) FROM crawler_jobs WHERE status = 'running') < ?
        `

    const startRes = profileId
      ? await db.prepare(startSql).run(jobId, maxGlobalConcurrency, profileId, jobId)
      : await db.prepare(startSql).run(jobId, maxGlobalConcurrency)

    const startedCount = Number(startRes?.changes ?? startRes?.rowCount ?? 0)
    if (startedCount === 0) {
      // Another job is already running for this profile, or we hit the global concurrency cap.
      // Apply bounded backoff and eventually dead-letter to prevent runaway retries.
      const attempts = Number(job.dispatch_attempts ?? 0) + 1
      const maxAttempts = getDispatchMaxAttempts()

      if (attempts > maxAttempts) {
        const deadLetter = {
          reason: 'dispatch_exhausted',
          attempts,
          max_attempts: maxAttempts,
          profile_id: profileId,
          max_global_concurrency: maxGlobalConcurrency,
          last_attempt_at: new Date().toISOString(),
        }

        await db.prepare(
          `
            UPDATE crawler_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error = ?,
                result_meta = COALESCE(?, result_meta)
            WHERE id = ?
          `,
        ).run(
          'Crawler dispatch exhausted due to concurrency limits',
          JSON.stringify({ dead_letter: deadLetter }),
          jobId,
        )
        return
      }

      const delayMs = computeBackoffMs(attempts)
      const nextAtIso = new Date(Date.now() + delayMs).toISOString()
      try {
        await db.prepare(
          `
            UPDATE crawler_jobs
            SET dispatch_attempts = ?,
                next_dispatch_at = ?,
                error = NULL
            WHERE id = ?
              AND status = 'queued'
          `,
        ).run(attempts, nextAtIso, jobId)
      } catch (error) {
        // best-effort; continue with in-process backoff anyway
        console.warn('[crawlerDispatcher] Failed to persist dispatch backoff metadata', error)
      }

      setTimeout(() => {
        dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(() => {})
      }, delayMs)
      return
    }

    // CRITICAL: Use snapshot if available, never load live profile data
    let profileContext = null
    try {
      if (job.profile_context_snapshot) {
        // Use stored snapshot (deterministic)
        profileContext = parseJSON(job.profile_context_snapshot)
        console.log('[crawlerDispatcher] Using stored profile snapshot for job', jobId)
      } else if (job.profile_id) {
        // Legacy fallback: build snapshot now (non-deterministic, but maintain backward compatibility)
        console.warn('[crawlerDispatcher] Job missing snapshot, building now (non-deterministic):', jobId)
        profileContext = await buildProfileContext(db, job.profile_id)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
      `).run(errorMsg, jobId)
      
      // Log to dead letter queue
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error,
        jobParameters: parseJSON(job.parameters),
        severity: determineSeverity(error, job.type),
      })
      return
    }

    let result = null

    const startedAt = Date.now()

    try {
      const parameters = parseJSON(job.parameters)
      const context = {
        db,
        job: { ...job, parameters },
        profileContext,
        dataDir,
        uploadDir,
        getOpenAI,
      }

      result = await handler(context)

      if (job.type === 'avatar_lookup' && result?.avatarUrl && profileContext?.profile) {
        const previous = await db
          .prepare('SELECT avatar_url FROM profiles WHERE id = ?')
          .get(profileContext.profile.id)
        await db.prepare(`
          UPDATE profiles
          SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(result.avatarUrl, profileContext.profile.id)

        if (previous?.avatar_url && previous.avatar_url.startsWith('/uploads/')) {
          // best-effort cleanup
          try {
            const absolutePath = join(uploadDir, previous.avatar_url.replace('/uploads/', ''))
            await fs.promises.unlink(absolutePath)
          } catch (error) {
            console.warn('[crawlerDispatcher] Failed to remove previous avatar', error)
          }
        }
      }

      const resultCountValue =
        typeof result?.inserted === 'number'
          ? result.inserted
          : typeof result?.result_count === 'number'
          ? result.result_count
          : null

      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const finalResultMeta = {
        ...(result?.result_meta ?? {}),
        duration_seconds: durationSeconds,
      }
      const resultMetaJson = JSON.stringify(finalResultMeta)

      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            -- IMPORTANT (Postgres): avoid untyped NULL params in "CASE WHEN $1 IS NULL".
            -- COALESCE(?, result_count) keeps the existing value when the handler doesn't return a count.
            result_count = COALESCE(?, result_count),
            result_meta = COALESCE(?, result_meta),
            error = NULL
        WHERE id = ?
      `).run(resultCountValue, resultMetaJson, jobId)
    } catch (error) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const finalResultMeta = {
        duration_seconds: durationSeconds,
        error: error instanceof Error ? error.message : String(error),
      }

      const errorMsg = error instanceof Error ? error.message : String(error)
      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?,
            result_meta = COALESCE(?, result_meta)
        WHERE id = ?
      `).run(errorMsg, JSON.stringify(finalResultMeta), jobId)
      
      // Log to dead letter queue for durable failure tracking
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error,
        jobParameters: parseJSON(job.parameters),
        profileContextSnapshot: profileContext,
        severity: determineSeverity(error, job.type),
      })
    }
  }

  // Return a Promise that resolves when the job completes
  return new Promise((resolve) => {
    setImmediate(() => {
      handle().then(resolve).catch((err) => {
        console.error('[crawlerDispatcher] Unhandled job error:', err)
        resolve() // Resolve anyway to not block
      })
    })
  })
}
