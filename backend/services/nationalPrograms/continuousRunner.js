import crypto from 'crypto'
import { dispatchCrawlerJob } from '../crawlerDispatcher.js'
import { auditLog } from './audit.js'

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
  if (!db) throw new Error('Database connection required for national programs crawler')

  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000

  const tick = async () => {
    const startedAt = Date.now()
    try {
      // Avoid overlapping runs
      const existing = db
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

      db.prepare(
        `
          INSERT INTO crawler_jobs (id, type, status, parameters, requested_by, created_at)
          VALUES (?, 'national', 'queued', ?, 'system', CURRENT_TIMESTAMP)
        `,
      ).run(jobId, JSON.stringify(parameters))

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

