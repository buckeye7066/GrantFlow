import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { processAvatarLookupJob } from './avatarCrawler.js'
import { processLocalCrawlerJob } from './localCrawler.js'
import { processScholarshipCrawlerJob } from './scholarshipCrawler.js'
import { processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { processItemCrawlerJob } from './itemCrawler.js'
import { processDocumentIngestionJob } from './documentIngestion.js'
import { processPipelineAutomationJob } from './pipelineAutomation.js'
import { loadProfileContext } from './profileHelpers.js'
import { processProfileEnrichmentJob } from './profileEnrichment.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const dataDir = join(__dirname, '..', 'data', 'crawlers')

const HANDLERS = {
  avatar_lookup: processAvatarLookupJob,
  local: processLocalCrawlerJob,
  scholarship: processScholarshipCrawlerJob,
  comprehensive: processComprehensiveCrawlerJob,
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

export function dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }) {
  const handle = async () => {
    const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ? LIMIT 1').get(jobId)
    if (!job) {
      console.warn('[crawlerDispatcher] Job not found', jobId)
      return
    }

    if (job.status && job.status !== 'queued') {
      return
    }

    const handler = HANDLERS[job.type]
    if (!handler) {
      db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
      `).run(`Unhandled crawler type "${job.type}"`, jobId)
      return
    }

    db.prepare(`
      UPDATE crawler_jobs
      SET status = 'running',
          started_at = CURRENT_TIMESTAMP,
          error = NULL,
          parameters = COALESCE(parameters, '{}')
      WHERE id = ?
    `).run(jobId)

    let profileContext = null
    try {
      if (job.profile_id) {
        profileContext = loadProfileContext(db, job.profile_id)
      }
    } catch (error) {
      db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
      `).run(
        error instanceof Error ? error.message : String(error),
        jobId,
      )
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
        const previous = db
          .prepare('SELECT avatar_url FROM profiles WHERE id = ?')
          .get(profileContext.profile.id)
        db.prepare(`
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

      db.prepare(`
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            result_count = CASE WHEN ? IS NULL THEN result_count ELSE ? END,
            result_meta = COALESCE(?, result_meta),
            error = NULL
        WHERE id = ?
      `).run(resultCountValue, resultCountValue, resultMetaJson, jobId)
    } catch (error) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const finalResultMeta = {
        duration_seconds: durationSeconds,
        error: error instanceof Error ? error.message : String(error),
      }

      db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?,
            result_meta = COALESCE(?, result_meta)
        WHERE id = ?
      `).run(
        error instanceof Error ? error.message : String(error),
        JSON.stringify(finalResultMeta),
        jobId,
      )
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
