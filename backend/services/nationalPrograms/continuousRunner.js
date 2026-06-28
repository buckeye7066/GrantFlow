import crypto from 'crypto'
import { dispatchCrawlerJob } from '../crawlerDispatcher.js'
import { auditLog } from './audit.js'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:nationalPrograms:continuousRunner')

function minutes(ms) {
  return Math.round(ms / 60000)
}

export function startNationalProgramsCrawler({
  db,
  uploadDir,
  intervalMinutes = 360,
  maxUrls = 200,
  maxDepth = 2,
  agents = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('Database connection required for national programs crawler')

  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000

  const tick = async () => {
    const startedAt = Date.now()
    try {
      // Avoid overlapping runs
      let existing;
      try {
        existing = db
          .prepare(
            `
              SELECT id, status, created_at
              FROM crawler_jobs
              WHERE type = 'national'
                AND (status = 'queued' OR status = 'running')
                AND (
                  parameters LIKE '%"mode":"programs"%'
                  OR parameters LIKE '%"mode": "programs"%'
                )
              ORDER BY created_at DESC
              LIMIT 1
            `,
          )
          .get()
      } catch (dbError) {
        await auditLog({
          action: 'continuous_db_error',
          error: dbError instanceof Error ? dbError.message : String(dbError),
        })
        return
      }

      if (existing) {
        await auditLog({
          action: 'continuous_skip',
          reason: 'existing_job_in_progress',
          job_id: existing.id,
          status: existing.status,
        })
        return
      }

      const jobId = crypto.randomUUID()
      const parameters = {
        mode: 'programs',
        max_urls: maxUrls,
        max_depth: maxDepth,
        ...(Array.isArray(agents) ? { agents } : {}),
        continuous_run: true,
      }

      try {
        db.prepare(
          `
            INSERT INTO crawler_jobs (id, type, status, parameters, requested_by, created_at)
            VALUES (?, 'national', 'queued', ?, 'system', CURRENT_TIMESTAMP)
          `,
        ).run(jobId, JSON.stringify(parameters))
      } catch (insertError) {
        await auditLog({
          action: 'continuous_insert_error',
          job_id: jobId,
          error: insertError instanceof Error ? insertError.message : String(insertError),
        })
        return
      }

      await auditLog({
        action: 'continuous_job_created',
        job_id: jobId,
        parameters,
      })

      // Fire-and-forget dispatch
      dispatchCrawlerJob({
        db,
        jobId,
        uploadDir,
        getOpenAI: () => null,
      }).catch(async (err) => {
        await auditLog({
          action: 'continuous_dispatch_error',
          job_id: jobId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Mark job as failed in database so it doesn't block future runs
        try {
          db.prepare('UPDATE crawler_jobs SET status = "failed" WHERE id = ?').run(jobId)
        } catch (updateError) {
          qualityLog.error('Failed to update job status:', updateError)
        }
      })
    } catch (error) {
      await auditLog({
        action: 'continuous_tick_error',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await auditLog({
        action: 'continuous_tick_complete',
        duration_minutes: minutes(Date.now() - startedAt),
      })
    }
  }

  // Kick off immediately, then on interval
  tick().catch(e => console.warn('[background]', e?.message || e))
  const handle = setInterval(() => tick().catch(e => console.warn('[background]', e?.message || e)), intervalMs)
  return () => clearInterval(handle)
}

