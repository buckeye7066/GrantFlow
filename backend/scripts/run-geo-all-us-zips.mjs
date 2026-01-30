import crypto from 'crypto'
import path from 'path'

import { db } from '../db/index.js'
import { createGeoCrawlRun } from '../services/geoCrawlRunStore.js'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForJob(jobId, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = await db.prepare('SELECT status, error, result_count FROM crawler_jobs WHERE id = ?').get(jobId)
    if (!row) throw new Error(`crawler_jobs row missing for job ${jobId}`)
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return row
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for geo crawl job ${jobId}`)
}

async function main() {
  // Ensure deterministic crawler datasets for local/dev runs.
  if (!process.env.CRAWLER_DATA_DIR) {
    process.env.CRAWLER_DATA_DIR = path.resolve(process.cwd(), 'backend', 'tests', 'fixtures', 'crawlers')
  }

  const batchSize = Number(process.env.GEO_BATCH_SIZE ?? 200)
  const rateLimitMs = Number(process.env.GEO_RATE_LIMIT_MS ?? 0)
  const minSources = Number(process.env.GEO_MIN_SOURCES_PER_ZIP ?? 3)

  const { dispatchCrawlerJob } = await import('../services/crawlerDispatcher.js')

  const geoJobId = crypto.randomUUID()
  const geoRunId = crypto.randomUUID()

  const params = {
    mode: 'geo',
    geo_run_id: geoRunId,
    run_all_states: true,
    // Deterministic/no-network default (baseline directory sources still produce results)
    offline_only: true,
    discover_local_resources: false,
    rate_limit_ms: rateLimitMs,
    batch_size: batchSize,
    min_sources_per_zip: minSources,
    // Long-run safety: resume across restarts
    resume: true,
  }

  await db
    .prepare(
      `
        INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
        VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'admin-script')
      `,
    )
    .run(geoJobId, JSON.stringify(params))

  await createGeoCrawlRun(db, {
    id: geoRunId,
    state: null,
    createdByUserId: 'admin-script',
    crawlerJobId: geoJobId,
  })

  await dispatchCrawlerJob({
    db,
    jobId: geoJobId,
    uploadDir: path.resolve(process.cwd(), 'backend', 'uploads'),
    getOpenAI: null,
  })

  const finalRow = await waitForJob(geoJobId, { timeoutMs: Number(process.env.GEO_TIMEOUT_MS ?? 30 * 60 * 1000) })
  console.log({
    geoRunId,
    geoJobId,
    status: finalRow.status,
    result_count: finalRow.result_count ?? null,
    error: finalRow.error ?? null,
  })

  if (finalRow.status !== 'completed') process.exit(1)
}

await main()

