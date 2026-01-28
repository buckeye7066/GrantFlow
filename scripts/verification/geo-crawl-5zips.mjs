#!/usr/bin/env node
/**
 * End-to-end GeoCrawl verification:
 * - starts a geo crawl for 5 ZIPs
 * - polls run + events until status is complete/failed
 * - prints DB evidence counts (geo index + opportunities)
 *
 * Requires backend running.
 *
 * Env:
 * - VERIFY_BACKEND_BASE_URL (default http://127.0.0.1:19181)
 * - VERIFY_ADMIN_TOKEN (default verify-admin-token)
 */
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'

const BASE = process.env.VERIFY_BACKEND_BASE_URL || 'http://127.0.0.1:19181'
const TOKEN = process.env.VERIFY_ADMIN_TOKEN || 'verify-admin-token'
const DB_PATH = process.env.VERIFY_DB_PATH || 'backend/data/grantflow.verify.db'

async function fetchJson(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function run() {
  const zips = ['37311', '37312', '37201', '10001', '30301']

  const startedAt = Date.now()
  const start = await fetchJson('/api/geo-crawl/start', {
    method: 'POST',
    body: { zips, discover_local_resources: true },
  })
  if (start.status !== 201 || !start.json?.run_id) {
    throw new Error(`Failed to start geo crawl: status=${start.status} body=${JSON.stringify(start.json)}`)
  }

  const runId = String(start.json.run_id)
  const jobId = String(start.json.crawler_job_id)

  let lastEventId = 0
  let status = 'queued'
  let finalRun = null
  const eventSamples = []

  for (let i = 0; i < 240; i += 1) {
    const runRes = await fetchJson(`/api/geo-crawl/runs/${encodeURIComponent(runId)}`)
    if (runRes.status !== 200) {
      throw new Error(`Failed to read run: ${runRes.status} ${JSON.stringify(runRes.json)}`)
    }
    finalRun = runRes.json?.run || null
    status = String(finalRun?.status || '')

    const eventsRes = await fetchJson(
      `/api/geo-crawl/runs/${encodeURIComponent(runId)}/events?after_id=${encodeURIComponent(lastEventId)}&limit=200`,
    )
    if (eventsRes.status === 200) {
      const evts = eventsRes.json?.events || []
      lastEventId = Number(eventsRes.json?.last_event_id || lastEventId)
      if (evts.length) {
        eventSamples.push(...evts.slice(-5))
      }
    }

    if (status === 'complete' || status === 'failed') break
    // keep the poll gentle; the dispatcher can take time
    // eslint-disable-next-line no-await-in-loop
    await delay(1000)
  }

  const db = new Database(DB_PATH, { readonly: true })
  const geoIndexCount = db
    .prepare('SELECT COUNT(*) AS n FROM funding_opportunity_geo_index WHERE geo_run_id = ?')
    .get(runId)
  const uniqueOppCount = db
    .prepare(
      `
        SELECT COUNT(DISTINCT opportunity_id) AS n
        FROM funding_opportunity_geo_index
        WHERE geo_run_id = ?
      `,
    )
    .get(runId)
  const byZip = db
    .prepare(
      `
        SELECT zip, state, COUNT(*) AS n
        FROM funding_opportunity_geo_index
        WHERE geo_run_id = ?
        GROUP BY zip, state
        ORDER BY zip ASC
      `,
    )
    .all(runId)
  db.close()

  console.log(
    JSON.stringify(
      {
        ok: true,
        backend: BASE,
        run_id: runId,
        crawler_job_id: jobId,
        zips,
        final_run: finalRun,
        last_event_id: lastEventId,
        event_sample: eventSamples.slice(-20),
        db_evidence: {
          geo_index_rows: Number(geoIndexCount?.n || 0),
          unique_opportunities: Number(uniqueOppCount?.n || 0),
          rows_by_zip: byZip,
        },
        elapsed_ms: Date.now() - startedAt,
      },
      null,
      2,
    ),
  )

  if (status !== 'complete') {
    process.exitCode = 2
  }
}

run().catch((err) => {
  console.error('[geo-crawl-5zips] failed:', err?.stack || err)
  process.exit(1)
})

