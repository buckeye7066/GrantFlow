import express from 'express'

const router = express.Router()

function requireAdminOrToken(req, res) {
  const user = req.user ?? { role: 'guest' }
  if (user.role === 'admin') return true
  const bulkKey = req.headers['x-bulk-key'] || req.headers['x-admin-token'] || null
  const expectedKey = process.env.BULK_POPULATE_KEY || 'grantflow-bulk-2026'
  if (bulkKey && bulkKey === expectedKey) return true
  res.status(403).json({ error: 'Admin access or valid bulk key required' })
  return false
}

router.get('/health', (req, res) => {
  try {
    const lastRun = req.db
      .prepare(
        `
          SELECT *
          FROM crawl_runs
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get()

    const running = req.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM crawl_runs
          WHERE status = 'running'
        `,
      )
      .get()?.count

    const staleDays = Math.max(1, Number.parseInt(process.env.CRAWLER_STALE_DAYS || '30', 10) || 30)
    const staleA = req.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM nf_programs_a
          WHERE last_verified IS NOT NULL
            AND DATETIME(last_verified) < DATETIME('now', ?)
        `,
      )
      .get(`-${staleDays} day`)?.count
    const staleB = req.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM nf_programs_b
          WHERE last_verified IS NOT NULL
            AND DATETIME(last_verified) < DATETIME('now', ?)
        `,
      )
      .get(`-${staleDays} day`)?.count

    res.json({
      status: 'ok',
      running_runs: running ?? 0,
      last_run: lastRun ?? null,
      stale_days: staleDays,
      stale_programs: {
        track_a: staleA ?? 0,
        track_b: staleB ?? 0,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message })
  }
})

router.get('/runs', (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? 50, 10) || 50))
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? 0, 10) || 0)
    const rows = req.db
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
    const total = req.db.prepare('SELECT COUNT(*) AS total FROM crawl_runs').get()?.total
    res.json({ data: rows, total: total ?? rows.length, limit, offset })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/runs/:id', (req, res) => {
  try {
    const run = req.db
      .prepare('SELECT * FROM crawl_runs WHERE crawl_run_id = ?')
      .get(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })

    const events = req.db
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

    const failures = req.db
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
  try {
    const {
      mode = 'SMOKE_MODE',
      state = null,
      use_live_sources = false,
      max_sources = 10,
      max_urls_per_source = 8,
      timeout_seconds = 25,
    } = req.body ?? {}

    const { runNationalCrawlerV2 } = await import('../services/nationalCrawlerV2/run.js')
    const result = await runNationalCrawlerV2({
      db: req.db,
      scopeMode: mode,
      state,
      useLiveSources: Boolean(use_live_sources),
      maxSources: Number(max_sources) || 10,
      maxUrlsPerSource: Number(max_urls_per_source) || 8,
      timeoutSeconds: Number(timeout_seconds) || 25,
    })

    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router

