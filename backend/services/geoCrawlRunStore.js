import crypto from 'crypto'

function nowExpr(db) {
  return db?.dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : "datetime('now')"
}

export async function createGeoCrawlRun(
  db,
  { id: runId = null, state = null, createdByUserId = null, crawlerJobId = null } = {},
) {
  const id = runId ? String(runId) : crypto.randomUUID()
  const st = state ? String(state).toUpperCase() : null

  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO geo_crawl_runs (id, created_at, created_by_user_id, status, state, crawler_job_id, last_heartbeat_at)
          VALUES (?, CURRENT_TIMESTAMP, ?, 'queued', ?, ?, CURRENT_TIMESTAMP)
        `
      : `
          INSERT INTO geo_crawl_runs (id, created_at, created_by_user_id, status, state, crawler_job_id, last_heartbeat_at)
          VALUES (?, datetime('now'), ?, 'queued', ?, ?, datetime('now'))
        `

  await db.prepare(sql).run(id, createdByUserId ?? null, st, crawlerJobId ?? null)
  return { id, state: st }
}

export async function markGeoCrawlRunRunning(db, runId) {
  if (!runId) return
  const sql =
    db?.dialect === 'postgres'
      ? `
          UPDATE geo_crawl_runs
          SET status = 'running',
              last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      : `
          UPDATE geo_crawl_runs
          SET status = 'running',
              last_heartbeat_at = datetime('now')
          WHERE id = ?
        `
  await db.prepare(sql).run(runId)
}

export async function updateGeoCrawlRunCurrent(db, runId, { state, zip, county, source } = {}) {
  if (!runId) return
  const st = state ? String(state).toUpperCase() : null
  const sql =
    db?.dialect === 'postgres'
      ? `
          UPDATE geo_crawl_runs
          SET state = COALESCE(?, state),
              current_zip = ?,
              current_county = ?,
              current_source = ?,
              last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      : `
          UPDATE geo_crawl_runs
          SET state = COALESCE(?, state),
              current_zip = ?,
              current_county = ?,
              current_source = ?,
              last_heartbeat_at = datetime('now')
          WHERE id = ?
        `
  await db.prepare(sql).run(st, zip ?? null, county ?? null, source ?? null, runId)
}

export async function incrementGeoCrawlRunCounts(db, runId, { processedZipDelta = 0, foundOppDelta = 0 } = {}) {
  if (!runId) return
  const sql =
    db?.dialect === 'postgres'
      ? `
          UPDATE geo_crawl_runs
          SET processed_zip_count = COALESCE(processed_zip_count, 0) + ?,
              found_opportunity_count = COALESCE(found_opportunity_count, 0) + ?,
              last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      : `
          UPDATE geo_crawl_runs
          SET processed_zip_count = COALESCE(processed_zip_count, 0) + ?,
              found_opportunity_count = COALESCE(found_opportunity_count, 0) + ?,
              last_heartbeat_at = datetime('now')
          WHERE id = ?
        `
  await db.prepare(sql).run(Number(processedZipDelta || 0), Number(foundOppDelta || 0), runId)
}

export async function completeGeoCrawlRun(db, runId, { status = 'complete', error = null } = {}) {
  if (!runId) return
  const normalized =
    status === 'failed' || status === 'paused' || status === 'running' || status === 'queued'
      ? status
      : 'complete'

  const sql =
    db?.dialect === 'postgres'
      ? `
          UPDATE geo_crawl_runs
          SET status = ?,
              last_error = ?,
              last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      : `
          UPDATE geo_crawl_runs
          SET status = ?,
              last_error = ?,
              last_heartbeat_at = datetime('now')
          WHERE id = ?
        `
  await db.prepare(sql).run(normalized, error ?? null, runId)
}

export async function appendGeoCrawlEvent(
  db,
  runId,
  { level = 'info', state = null, zip = null, county = null, source = null, message = '', foundCountDelta = 0 } = {},
) {
  if (!runId) return null
  const lvl = ['info', 'warn', 'error'].includes(String(level)) ? String(level) : 'info'
  const st = state ? String(state).toUpperCase() : null

  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO geo_crawl_events (run_id, ts, level, state, zip, county, source, message, found_count_delta)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `
      : `
          INSERT INTO geo_crawl_events (run_id, ts, level, state, zip, county, source, message, found_count_delta)
          VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
        `

  if (db?.dialect === 'postgres') {
    const row = await db
      .prepare(sql)
      .get(runId, lvl, st, zip ?? null, county ?? null, source ?? null, message ?? null, Number(foundCountDelta || 0))
    return row?.id ?? null
  }

  const info = await db
    .prepare(sql)
    .run(runId, lvl, st, zip ?? null, county ?? null, source ?? null, message ?? null, Number(foundCountDelta || 0))
  return info?.lastInsertRowid ?? null
}

export async function getGeoCrawlRun(db, runId) {
  if (!runId) return null
  const row = await db.prepare('SELECT * FROM geo_crawl_runs WHERE id = ?').get(runId)
  return row ?? null
}

export async function listGeoCrawlEvents(db, runId, { afterId = 0, limit = 200 } = {}) {
  if (!runId) return []
  const lim = Math.max(1, Math.min(500, Number(limit || 200)))
  const after = Math.max(0, Number(afterId || 0))

  const sql =
    db?.dialect === 'postgres'
      ? `
          SELECT *
          FROM geo_crawl_events
          WHERE run_id = ?
            AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `
      : `
          SELECT *
          FROM geo_crawl_events
          WHERE run_id = ?
            AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `
  return (await db.prepare(sql).all(runId, after, lim)) ?? []
}

