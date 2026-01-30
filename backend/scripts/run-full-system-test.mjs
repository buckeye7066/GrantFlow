import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

import { db } from '../db/index.js'
import { ensureItemCatalogSeeded, suggestItemsForProfile } from '../services/itemCatalogService.js'
import { createCrawlerJob } from '../services/crawlerJobCreation.js'
import { buildProfileContext } from '../services/profileHelpers.js'
import { saveToProfilePipeline } from '../services/opportunityMatcher.js'
import { createGeoCrawlRun } from '../services/geoCrawlRunStore.js'

const __filename = fileURLToPath(import.meta.url)
const __scriptDir = path.dirname(__filename)

function ensureCrawlerDataDir() {
  // Prefer deterministic, repo-contained crawler datasets when available.
  // IMPORTANT: `crawlerDispatcher.js` reads CRAWLER_DATA_DIR at module import time,
  // so we must set this before we import/require the dispatcher.
  if (process.env.CRAWLER_DATA_DIR) return String(process.env.CRAWLER_DATA_DIR)
  const resolved = path.resolve(__scriptDir, '..', 'tests', 'fixtures', 'crawlers')
  process.env.CRAWLER_DATA_DIR = resolved
  return resolved
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForJob(jobId, { timeoutMs = 60 * 60 * 1000, pollMs = 2500 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = await db.prepare('SELECT id, status, error, started_at, created_at, completed_at, type, profile_id FROM crawler_jobs WHERE id = ?').get(jobId)
    if (!row) throw new Error(`crawler_jobs row missing for job ${jobId}`)
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return row
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for job ${jobId} (${row.type})`)
    await sleep(pollMs)
  }
}

async function saveJobHighMatchesToPipeline({ jobId, profileId, threshold = 50 }) {
  const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
  if (!job || job.status !== 'completed') return { job_id: jobId, profile_id: profileId, saved: 0, skipped: 0, message: 'job not completed' }

  const parseJson = (value, fallback) => {
    try {
      return value && typeof value === 'string' ? JSON.parse(value) : (value ?? fallback)
    } catch {
      return fallback
    }
  }

  const jobParams = parseJson(job.parameters, {})

  // Map crawler job type -> opportunity source(s) it writes.
  // This prevents us from accidentally pulling unrelated opportunities that happened to update recently.
  const sourcesByJobType = {
    local: ['local_foundation'],
    scholarship: ['scholarship_crawler'],
    health_resources: ['health_resources_crawler'],
    comprehensive: ['verified_real'],
    item_search: ['item_funding'],
    item_gift_search: ['item_gift'],
  }

  const sources = sourcesByJobType[job.type] || null

  const profileContext = await buildProfileContext(db, profileId)

  // IMPORTANT:
  // Item crawlers are query-driven. If profile data is sparse, we must not "hard fail" by scoring below threshold.
  // We boost match scoring by injecting the item query terms into the profile keyword set.
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

  const since = job.started_at || job.created_at || null

  const sourceClause = Array.isArray(sources) && sources.length ? `AND source IN (${sources.map(() => '?').join(', ')})` : ''

  const opps = await db
    .prepare(
      `
        SELECT *
        FROM funding_opportunities
        WHERE (profile_id = ? OR profile_id IS NULL)
          AND (created_at >= COALESCE(?, created_at) OR updated_at >= COALESCE(?, updated_at))
          ${sourceClause}
        ORDER BY updated_at DESC
        LIMIT 2000
      `,
    )
    .all(profileId, since, since, ...(sources || []))

  let saved = 0
  let skipped = 0
  let eligible = 0
  for (const opp of opps || []) {
    const res = await saveToProfilePipeline(db, opp, profileId, profileContext, null, threshold)
    const pct = typeof res?.matchPercentage === 'number' ? res.matchPercentage : null
    if (pct != null && pct >= threshold) eligible += 1
    if (res?.saved) saved += 1
    else skipped += 1
  }

  if (opps.length > 0 && saved === 0) {
    console.info('[full-test] 0 pipeline inserts', { job_id: jobId, profile_id: profileId, opps: opps.length, eligible, threshold })
  }

  return { job_id: jobId, profile_id: profileId, opportunities: opps.length, eligible, saved, skipped, threshold }
}

async function main() {
  const crawlerDataDir = ensureCrawlerDataDir()
  const { dispatchCrawlerJob } = await import('../services/crawlerDispatcher.js')

  const matchThreshold = Number(process.env.MATCH_THRESHOLD ?? 50)
  const itemSuggestionsPerProfile = Math.max(0, Math.min(5, Number(process.env.ITEM_SUGGESTIONS_PER_PROFILE ?? 3)))
  const runItemCrawlers = String(process.env.RUN_ITEM_CRAWLERS ?? 'true').toLowerCase() !== 'false'
  const runGeoCrawl = String(process.env.RUN_GEO_CRAWL ?? 'true').toLowerCase() !== 'false'

  console.log('[full-test] starting', {
    matchThreshold,
    itemSuggestionsPerProfile,
    runItemCrawlers,
    runGeoCrawl,
    crawler_data_dir: crawlerDataDir,
    sqlite_path: process.env.SQLITE_DB_PATH || null,
    provider: process.env.DB_PROVIDER || process.env.DB_DIALECT || 'sqlite',
  })

  // Ensure catalog is available for suggestions.
  try {
    await ensureItemCatalogSeeded(db)
  } catch (e) {
    console.warn('[full-test] item catalog seed failed (continuing):', e?.message || e)
  }

  const profiles = await db
    .prepare(`SELECT id, display_name FROM profiles WHERE status = 'active' ORDER BY created_at ASC`)
    .all()

  console.log(`[full-test] active profiles: ${profiles.length}`)
  if (!profiles.length) {
    throw new Error('No active profiles found. Seed profiles first (e.g. backend/scripts/setup-all-profiles.mjs).')
  }

  // 1) Core crawlers for all profiles (opportunity-producing crawlers that do NOT require an item query).
  const core = ['local', 'scholarship', 'health_resources', 'comprehensive']
  console.log('[full-test] running core crawlers for all profiles...', core)

  const coreTimeoutMs = Number(process.env.CORE_TIMEOUT_MINUTES ?? 120) * 60 * 1000
  let coreCreated = 0
  let coreCompleted = 0
  let coreFailed = 0

  for (const profile of profiles) {
    for (const type of core) {
      const created = await createCrawlerJob(db, {
        type,
        profileId: profile.id,
        organizationId: null,
        parameters: {
          autonomous_run: true,
          profile_id: profile.id,
        },
        requestedBy: 'admin-script',
        status: 'queued',
        buildSnapshot: true,
        // IMPORTANT: core crawls must be re-runnable; crawler_jobs.idempotency_key is UNIQUE.
        skipIdempotencyCheck: true,
      })

      const jobId = created?.jobId
      if (!jobId) continue
      coreCreated += 1

      await dispatchCrawlerJob({
        db,
        jobId,
        uploadDir: path.join(process.cwd(), 'uploads'),
        getOpenAI: null,
      })

      const finalRow = await waitForJob(jobId, { timeoutMs: coreTimeoutMs })
      if (finalRow.status === 'failed') {
        coreFailed += 1
        console.warn('[full-test] core job failed', { profile: profile.id, type, jobId, error: finalRow.error })
        continue
      }

      coreCompleted += 1
      await saveJobHighMatchesToPipeline({ jobId, profileId: profile.id, threshold: matchThreshold })
    }
  }

  console.log('[full-test] core crawl complete', {
    jobs_created: coreCreated,
    jobs_completed: coreCompleted,
    jobs_failed: coreFailed,
  })

  // 2) Item crawlers (per profile) using suggestions as queries.
  if (runItemCrawlers && itemSuggestionsPerProfile > 0) {
    console.log('[full-test] running item crawlers per profile...')
    for (const profile of profiles) {
      const suggestions = await suggestItemsForProfile(db, { profileId: profile.id, limit: itemSuggestionsPerProfile })
      const items = (suggestions?.suggestions || []).map((s) => s?.name).filter(Boolean)
      if (!items.length) {
        console.log('[full-test] no item suggestions for profile', profile.id)
        continue
      }

      for (const item of items) {
        for (const type of ['item_search', 'item_gift_search']) {
          const created = await createCrawlerJob(db, {
            type,
            profileId: profile.id,
            organizationId: null,
            parameters: {
              autonomous_run: true,
              profile_id: profile.id,
              item,
              match_threshold: matchThreshold,
              max_results: 25,
            },
            requestedBy: 'admin-script',
            status: 'queued',
            buildSnapshot: true,
            skipIdempotencyCheck: true,
          })

          const jobId = created?.jobId
          if (!jobId) continue

          await dispatchCrawlerJob({
            db,
            jobId,
            uploadDir: path.join(process.cwd(), 'uploads'),
            getOpenAI: null,
          })

          const finalRow = await waitForJob(jobId, { timeoutMs: 60 * 60 * 1000 })
          if (finalRow.status === 'failed') {
            console.warn('[full-test] item job failed', { profile: profile.id, type, item, jobId, error: finalRow.error })
            continue
          }

          const savedReport = await saveJobHighMatchesToPipeline({ jobId, profileId: profile.id, threshold: matchThreshold })
          console.log('[full-test] item job ok', { profile: profile.id, type, item, ...savedReport })
        }
      }
    }
  }

  // 3) Geo crawl across all profile ZIP codes (offline + fast defaults).
  if (runGeoCrawl) {
    const zipRows = await db
      .prepare(
        `
          SELECT postal_code
          FROM profiles
          WHERE status = 'active'
        `,
      )
      .all()

    const zips = Array.from(
      new Set(
        (zipRows || [])
          .map((r) => String(r?.postal_code || '').trim())
          .filter((z) => /^\d{5}$/.test(z)),
      ),
    ).sort()

    console.log('[full-test] starting geo crawl across profile ZIPs (offline)...', { zip_count: zips.length })

    const geoJobId = crypto.randomUUID()
    const geoRunId = crypto.randomUUID()
    const parameters = {
      mode: 'geo',
      geo_run_id: geoRunId,
      zip_list: zips,
      max_zips: zips.length,
      offline_only: true,
      discover_local_resources: false,
      rate_limit_ms: 0,
      batch_size: Number(process.env.GEO_BATCH_SIZE ?? 50),
      min_sources_per_zip: Number(process.env.GEO_MIN_SOURCES_PER_ZIP ?? 3),
      resume: false,
    }

    await db
      .prepare(
        `
          INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
          VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'admin-script')
        `,
      )
      .run(geoJobId, JSON.stringify(parameters))

    // Ensure the run exists before Geo Crawl tries to append events (FK on geo_crawl_events.run_id).
    await createGeoCrawlRun(db, {
      id: geoRunId,
      state: null,
      createdByUserId: 'admin-script',
      crawlerJobId: geoJobId,
    })

    await dispatchCrawlerJob({
      db,
      jobId: geoJobId,
      uploadDir: path.join(process.cwd(), 'uploads'),
      getOpenAI: null,
    })

    const finalGeo = await waitForJob(geoJobId, { timeoutMs: Number(process.env.GEO_TIMEOUT_MS ?? 12 * 60 * 60 * 1000) })
    if (finalGeo.status !== 'completed') {
      throw new Error(`Geo crawl failed: ${finalGeo.error || 'unknown error'}`)
    }

    console.log('[full-test] geo crawl completed', { geo_run_id: geoRunId, job_id: geoJobId })
  }

  console.log('[full-test] done')
}

await main()

