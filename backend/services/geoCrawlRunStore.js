import crypto from 'crypto'

function nowExpr(db) {
  return db?.dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : "datetime('now')"
}

let ensured = false
let ensurePromise = null

async function ensureGeoCrawlSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensured) return
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'

    // Runs table
    const createRuns = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS geo_crawl_runs (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ DEFAULT now(),
            created_by_user_id TEXT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','complete')),
            state TEXT NULL,
            current_zip TEXT NULL,
            current_county TEXT NULL,
            current_source TEXT NULL,
            processed_zip_count INTEGER DEFAULT 0,
            found_opportunity_count INTEGER DEFAULT 0,
            last_heartbeat_at TIMESTAMPTZ NULL,
            last_error TEXT NULL,
            crawler_job_id TEXT NULL REFERENCES crawler_jobs(id) ON DELETE SET NULL
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS geo_crawl_runs (
            id TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by_user_id TEXT,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','complete')),
            state TEXT,
            current_zip TEXT,
            current_county TEXT,
            current_source TEXT,
            processed_zip_count INTEGER DEFAULT 0,
            found_opportunity_count INTEGER DEFAULT 0,
            last_heartbeat_at DATETIME,
            last_error TEXT,
            crawler_job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL
          );
        `

    // Events table
    const createEvents = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS geo_crawl_events (
            id BIGSERIAL PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES geo_crawl_runs(id) ON DELETE CASCADE,
            ts TIMESTAMPTZ DEFAULT now(),
            level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
            state TEXT NULL,
            zip TEXT NULL,
            county TEXT NULL,
            source TEXT NULL,
            message TEXT NULL,
            found_count_delta INTEGER DEFAULT 0
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS geo_crawl_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES geo_crawl_runs(id) ON DELETE CASCADE,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP,
            level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
            state TEXT,
            zip TEXT,
            county TEXT,
            source TEXT,
            message TEXT,
            found_count_delta INTEGER DEFAULT 0
          );
        `

    // Association index for per-run / per-zip attribution
    const createGeoIndex = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
            id TEXT PRIMARY KEY,
            opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
            geo_run_id TEXT,
            state TEXT,
            zip TEXT,
            county TEXT,
            source TEXT,
            created_at TIMESTAMPTZ DEFAULT now()
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
            geo_run_id TEXT,
            state TEXT,
            zip TEXT,
            county TEXT,
            source TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `

    // IMPORTANT:
    // - This is called from request/worker paths in production.
    // - If schema creation fails once (e.g., migrations lag), we MUST NOT permanently mark it as "ensured".
    //   Otherwise later requests will keep failing with "relation does not exist".
    try {
      // Core tables must exist for the monitor endpoints to work.
      await db.prepare(createRuns).run()
      await db.prepare(createEvents).run()

      // Optional: association index table (used for durable per-zip attribution).
      try {
        await db.prepare(createGeoIndex).run()
        await db
          .prepare(
            `
              CREATE UNIQUE INDEX IF NOT EXISTS uniq_fo_geo_index
              ON funding_opportunity_geo_index(opportunity_id, geo_run_id, state, zip, source);
            `,
          )
          .run()
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fo_geo_index_run_id ON funding_opportunity_geo_index(geo_run_id);`).run()
      } catch (error) {
        console.warn('[geoCrawlRunStore] Unable to ensure funding_opportunity_geo_index (continuing):', error?.message || error)
      }

      // Indexes (best-effort)
      try {
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_status ON geo_crawl_runs(status);`).run()
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_state ON geo_crawl_runs(state);`).run()
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_job ON geo_crawl_runs(crawler_job_id);`).run()

        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id ON geo_crawl_events(run_id);`).run()
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_id ON geo_crawl_events(run_id, id);`).run()
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_ts ON geo_crawl_events(run_id, ts);`).run()
      } catch (error) {
        console.warn('[geoCrawlRunStore] Unable to ensure geo crawl indexes (continuing):', error?.message || error)
      }

      // Legacy columns on funding_opportunities (some UIs rely on these).
      // Best-effort and do not fail requests if ALTER isn't permitted.
      if (isPostgres) {
        try {
          await db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_run_id TEXT;`).run()
          await db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_zip TEXT;`).run()
          await db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_county TEXT;`).run()
          await db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_source TEXT;`).run()
          await db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_scope TEXT;`).run()
        } catch (error) {
          console.warn('[geoCrawlRunStore] Unable to ensure geo_* columns on funding_opportunities (continuing):', error?.message || error)
        }
      }

      ensured = true
    } catch (error) {
      // Allow future calls to retry schema creation.
      ensurePromise = null
      ensured = false
      throw error
    }
  })()

  return ensurePromise
}

export async function createGeoCrawlRun(
  db,
  { id: runId = null, state = null, createdByUserId = null, crawlerJobId = null } = {},
) {
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
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
  await ensureGeoCrawlSchema(db)
  const row = await db.prepare('SELECT * FROM geo_crawl_runs WHERE id = ?').get(runId)
  return row ?? null
}

export async function listGeoCrawlEvents(db, runId, { afterId = 0, limit = 200 } = {}) {
  if (!runId) return []
  await ensureGeoCrawlSchema(db)
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

