import dotenv from 'dotenv'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { getDb } from '../backend/db/index.js'
import { dispatchCrawlerJob } from '../backend/services/crawlerDispatcher.js'
import { createGeoCrawlRun, getGeoCrawlRun, listGeoCrawlEvents } from '../backend/services/geoCrawlRunStore.js'

dotenv.config()

function parseZipList(argv) {
  const raw = argv.find((arg) => arg.startsWith('--zips='))?.slice('--zips='.length) ?? ''
  if (!raw) {
    // 5 ZIPs across multiple states for a quick sanity run.
    return ['10001', '30301', '37209', '60601', '90001']
  }
  return raw
    .split(',')
    .map((z) => String(z).trim())
    .filter(Boolean)
}

function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`) || argv.includes(`--${name}=true`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const argv = process.argv.slice(2)
  const zipList = parseZipList(argv)
  const discoverLocalResources = !parseBoolFlag(argv, 'no-overpass')

  const db = getDb()

  // Ensure uploads dir exists (best-effort). Some job handlers expect it.
  const uploadDir = process.env.UPLOAD_DIR
    ? path.resolve(String(process.env.UPLOAD_DIR))
    : path.resolve(process.cwd(), 'backend', 'uploads')
  try {
    fs.mkdirSync(uploadDir, { recursive: true })
  } catch {
    // ignore
  }

  const geoRunId = crypto.randomUUID()
  const jobId = crypto.randomUUID()

  const parameters = {
    mode: 'geo',
    geo_run_id: geoRunId,
    zip_list: zipList,
    max_zips: zipList.length,
    discover_local_resources: discoverLocalResources,
  }

  await db
    .prepare(
      `
        INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
        VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'dev-script')
      `,
    )
    .run(jobId, JSON.stringify(parameters))

  await createGeoCrawlRun(db, {
    id: geoRunId,
    state: null,
    createdByUserId: null,
    crawlerJobId: jobId,
  })

  // Start job processing in-process.
  const jobPromise = dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI: null })

  console.log(`[geo-dev] started geo crawl`)
  console.log(`[geo-dev] run_id=${geoRunId}`)
  console.log(`[geo-dev] crawler_job_id=${jobId}`)
  console.log(`[geo-dev] zip_list=${zipList.join(',')}`)
  console.log(`[geo-dev] discover_local_resources=${discoverLocalResources}`)
  console.log('')

  // Poll progress + events until completion.
  let afterId = 0
  let lastStatus = null
  for (;;) {
    const run = await getGeoCrawlRun(db, geoRunId)
    if (run?.status && run.status !== lastStatus) {
      lastStatus = run.status
      console.log(
        `[geo-dev] status=${run.status} processed=${run.processed_zip_count ?? 0} found_new=${run.found_opportunity_count ?? 0} current=${[
          run.current_zip,
          run.current_county,
          run.current_source,
        ]
          .filter(Boolean)
          .join(' • ')}`,
      )
    }

    const events = await listGeoCrawlEvents(db, geoRunId, { afterId, limit: 200 })
    for (const ev of events) {
      afterId = Number(ev.id) || afterId
      const prefix = String(ev.level || 'info').toUpperCase().padEnd(5, ' ')
      const ctx = [ev.state, ev.zip, ev.county, ev.source].filter(Boolean).join(' • ')
      const delta = Number(ev.found_count_delta || 0) > 0 ? ` (+${ev.found_count_delta})` : ''
      console.log(`[geo-dev] ${prefix} ${ctx || '—'} :: ${ev.message || '—'}${delta}`)
    }

    if (run?.status === 'complete' || run?.status === 'failed') break
    await sleep(1200)
  }

  await jobPromise

  // Verify results flow to global opportunities table + per-run association index.
  const row = await db
    .prepare('SELECT COUNT(*) as c FROM funding_opportunity_geo_index WHERE geo_run_id = ?')
    .get(geoRunId)
  console.log('')
  console.log(`[geo-dev] funding_opportunity_geo_index rows for geo_run_id: ${Number(row?.c ?? 0)}`)

  const samples =
    (await db
      .prepare(
        `
          SELECT
            fo.title,
            fo.state,
            gi.zip AS geo_zip,
            gi.county AS geo_county,
            gi.source AS geo_source,
            fo.application_url,
            fo.source_url
          FROM funding_opportunity_geo_index gi
          JOIN funding_opportunities fo ON fo.id = gi.opportunity_id
          WHERE gi.geo_run_id = ?
          ORDER BY gi.created_at DESC
          LIMIT 10
        `,
      )
      .all(geoRunId)) ?? []

  for (const s of samples) {
    const url = s.application_url || s.source_url || ''
    console.log(
      `[geo-dev] sample: ${String(s.state || '').padEnd(2, ' ')} ${String(s.geo_zip || '').padEnd(5, ' ')} ${String(
        s.geo_county || '',
      )} :: ${String(s.geo_source || '')} :: ${String(s.title || '').slice(0, 70)} :: ${url}`,
    )
  }

  if (Number(row?.c ?? 0) === 0) {
    process.exitCode = 2
    console.error('[geo-dev] FAIL: no run results saved for this geo run.')
  }
}

main().catch((err) => {
  console.error('[geo-dev] fatal error:', err)
  process.exitCode = 1
})

