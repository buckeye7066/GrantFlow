import express from 'express'

const router = express.Router()

function requireAdminOrToken(req, res) {
  if (req.ctx?.isAdmin) return true
  const bulkKey = req.headers['x-bulk-key'] || req.headers['x-admin-token'] || null
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  if (bulkKey && expectedKey && bulkKey === expectedKey) return true
  res.status(403).json({ error: 'Admin access or valid bulk key required' })
  return false
}

router.get('/health', async (req, res) => {
  if (!requireAdminOrToken(req, res)) return
  try {
    const lastRun = await req.db
      .prepare(
        `
          SELECT *
          FROM crawl_runs
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get()

    // PRECEDENCE TRAP: `await x.get()?.count` parses as `await (x.get()?.count)`.
    // On the SQLite shim `.get()` is synchronous so `?.count` reads a real row;
    // on prod Postgres `.get()` returns a PROMISE, `?.count` is `undefined`, and
    // `Number(undefined ?? 0)` is 0 — so this whole health endpoint reported
    // "0 running runs / 0 stale programs" permanently in production while doing
    // nothing. Await the row FIRST, then read the column.
    const runningRow = await req.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM crawl_runs
          WHERE status = 'running'
        `,
      )
      .get()
    const running = runningRow?.count

    const staleDays = Math.max(1, Number.parseInt(process.env.CRAWLER_STALE_DAYS || '30', 10) || 30)
    const isPostgres = req.db?.dialect === 'postgres'
    const staleSqlA = isPostgres
      ? `SELECT COUNT(*) AS count FROM nf_programs_a WHERE last_verified IS NOT NULL AND last_verified < (NOW() - (? * INTERVAL '1 day'))`
      : `SELECT COUNT(*) AS count FROM nf_programs_a WHERE last_verified IS NOT NULL AND DATETIME(last_verified) < DATETIME('now', ?)`
    const staleSqlB = isPostgres
      ? `SELECT COUNT(*) AS count FROM nf_programs_b WHERE last_verified IS NOT NULL AND last_verified < (NOW() - (? * INTERVAL '1 day'))`
      : `SELECT COUNT(*) AS count FROM nf_programs_b WHERE last_verified IS NOT NULL AND DATETIME(last_verified) < DATETIME('now', ?)`
    const staleParam = isPostgres ? staleDays : `-${staleDays} day`
    const staleARow = await req.db.prepare(staleSqlA).get(staleParam)
    const staleBRow = await req.db.prepare(staleSqlB).get(staleParam)
    const staleA = staleARow?.count
    const staleB = staleBRow?.count

    res.json({
      status: 'ok',
      running_runs: Number(running ?? 0),
      last_run: lastRun ?? null,
      stale_days: staleDays,
      stale_programs: {
        track_a: Number(staleA ?? 0),
        track_b: Number(staleB ?? 0),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message })
  }
})

router.get('/runs', async (req, res) => {
  if (!requireAdminOrToken(req, res)) return
  try {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? 50, 10) || 50))
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? 0, 10) || 0)
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawl_runs
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(limit, offset)
    const total = await req.db.prepare('SELECT COUNT(*) AS total FROM crawl_runs').get()
    res.json({ data: rows, total: Number(total?.total ?? rows.length), limit, offset })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/runs/:id', async (req, res) => {
  if (!requireAdminOrToken(req, res)) return
  try {
    const run = await req.db
      .prepare('SELECT * FROM crawl_runs WHERE crawl_run_id = ?')
      .get(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })

    const events = await req.db
      .prepare(
        `
          SELECT *
          FROM crawl_events
          WHERE crawl_run_id = ?
          ORDER BY created_at DESC
          LIMIT 200
        `,
      )
      .all(req.params.id)

    const failures = await req.db
      .prepare(
        `
          SELECT *
          FROM parse_failures
          WHERE crawl_run_id = ?
          ORDER BY created_at DESC
          LIMIT 200
        `,
      )
      .all(req.params.id)

    res.json({ run, events, failures })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/run', async (req, res) => {
  if (!requireAdminOrToken(req, res)) return
  return res.status(410).json({
    success: false,
    error: 'national_crawler_v2_retired',
    engine: 'crawler-os',
    message: 'National Crawler V2 has been retired. Use Crawler OS profile discovery instead.',
  })
})

export default router
