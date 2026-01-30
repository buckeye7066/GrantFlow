import crypto from 'crypto'
import path from 'path'

import { db } from '../db/index.js'
import { createGeoCrawlRun } from '../services/geoCrawlRunStore.js'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  // Ensure crawler dispatcher picks deterministic fixture datasets by default.
  if (!process.env.CRAWLER_DATA_DIR) {
    process.env.CRAWLER_DATA_DIR = path.resolve(process.cwd(), 'backend', 'tests', 'fixtures', 'crawlers')
  }

  const { dispatchCrawlerJob } = await import('../services/crawlerDispatcher.js')

  const sections = await db
    .prepare(
      `
        SELECT ps.profile_id, ps.section_key, ps.data
        FROM profile_sections ps
        JOIN profiles p ON p.id = ps.profile_id
        WHERE p.status = 'active'
          AND ps.section_key IN ('basic_information', 'location_focus')
      `,
    )
    .all()

  const zipsSet = new Set()
  const tryAddZip = (value) => {
    const zip = String(value || '').trim()
    if (/^\d{5}$/.test(zip)) zipsSet.add(zip)
  }

  for (const row of sections || []) {
    let parsed = null
    try {
      parsed = row?.data ? JSON.parse(String(row.data)) : null
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object') continue

    // Common field names
    tryAddZip(parsed.zip)
    tryAddZip(parsed.zip_code)
    tryAddZip(parsed.zipcode)
    tryAddZip(parsed.postal_code)

    // Nested address payloads (varies by schema versions)
    if (parsed.address && typeof parsed.address === 'object') {
      tryAddZip(parsed.address.zip)
      tryAddZip(parsed.address.zip_code)
      tryAddZip(parsed.address.zipcode)
      tryAddZip(parsed.address.postal_code)
    }
  }

  const zips = Array.from(zipsSet).sort()

  const geoJobId = crypto.randomUUID()
  const geoRunId = crypto.randomUUID()

  const params = {
    mode: 'geo',
    geo_run_id: geoRunId,
    zip_list: zips,
    max_zips: zips.length,
    offline_only: true,
    discover_local_resources: false,
    rate_limit_ms: 0,
    batch_size: 25,
    min_sources_per_zip: 3,
    resume: false,
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

  const start = Date.now()
  while (Date.now() - start < 5 * 60 * 1000) {
    const row = await db.prepare('SELECT status, error, result_count FROM crawler_jobs WHERE id = ?').get(geoJobId)
    if (!row) throw new Error(`crawler_jobs row missing for job ${geoJobId}`)
    if (['completed', 'failed', 'cancelled'].includes(row.status)) {
      console.log({
        geoRunId,
        geoJobId,
        zip_count: zips.length,
        status: row.status,
        result_count: row.result_count ?? null,
        error: row.error ?? null,
      })
      if (row.status !== 'completed') process.exit(1)
      return
    }
    await sleep(1000)
  }

  throw new Error(`Timed out waiting for geo crawl job ${geoJobId}`)
}

await main()

