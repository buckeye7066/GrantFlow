/**
 * POST /api/admin/crawl-coverage-actions/run-source — the CrawlCoverage
 * dashboard's "Run now" action on a stale source row.
 *
 * Proves the contract in backend/routes/adminCrawlCoverageActions.js:
 *   1. Non-admin callers are rejected (401/403), never 200.
 *   2. source_id is required.
 *   3. A source_id with no Crawler OS registry entry is an honest 404
 *      (`source_not_crawlable`) — never a silent no-op pretending success.
 *   4. A crawlable source_id with no profile_id in the body runs against the
 *      single most-recently-active profile, scoped to ONLY that source
 *      (onlySourceIds) — never a full fleet crawl.
 *   5. An explicit profile_id is validated and passed through as-is.
 *   6. No active profile at all → honest 404 (no_active_profile), not a crawl
 *      of nothing.
 *   7. A run that exceeds the gateway budget reports partial/timed_out
 *      instead of hanging the request.
 *
 * The actual Crawler OS discovery call is mocked at the module boundary
 * (runProfileDiscoveryLive) — this test proves the ROUTE's contract, not the
 * discovery pipeline itself (that's covered by crawler-os/tests + the
 * runDiscovery onlySourceIds unit coverage).
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Small budget so the timeout test resolves quickly. Must be set BEFORE the
// route module is imported (the budget constant is module-scoped).
process.env.ADMIN_RUN_SOURCE_BUDGET_MS = '150'

const runLiveMock = vi.fn()

vi.mock('../services/crawlerOsService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runProfileDiscoveryLive: (...a) => runLiveMock(...a) }
})

const runSourceRouter = (await import('../routes/adminCrawlCoverageActions.js')).default

function seedSchema(db) {
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, status TEXT DEFAULT 'active',
      display_name TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO profiles (id, status, display_name, updated_at)
      VALUES ('profile-old', 'active', 'Older Profile', '2026-01-01T00:00:00Z');
    INSERT INTO profiles (id, status, display_name, updated_at)
      VALUES ('profile-new', 'active', 'Newer Profile', '2026-06-01T00:00:00Z');
    INSERT INTO profiles (id, status, display_name, updated_at)
      VALUES ('profile-archived', 'archived', 'Archived Profile', '2026-07-01T00:00:00Z');
  `)
}

function makeDb() {
  const db = new Database(':memory:')
  seedSchema(db)
  // Minimal prepare().get()/.all() shim matching the async db interface the
  // route expects (mirrors other lightweight route tests in this suite).
  const wrap = (stmt) => ({
    get: async (...args) => stmt.get(...args),
    all: async (...args) => stmt.all(...args),
    run: async (...args) => stmt.run(...args),
  })
  return {
    dialect: 'sqlite',
    prepare: (sql) => wrap(db.prepare(sql)),
  }
}

function createApp(db, { isAdmin = true, authenticated = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    if (authenticated) req.user = { userId: 'admin-1' }
    req.ctx = { userId: authenticated ? 'admin-1' : null, isAdmin }
    next()
  })
  app.use('/api/admin/crawl-coverage-actions', runSourceRouter)
  return app
}

describe('POST /api/admin/crawl-coverage-actions/run-source', () => {
  let db

  beforeEach(() => {
    db = makeDb()
    runLiveMock.mockReset()
  })

  it('rejects a non-admin caller', async () => {
    const app = createApp(db, { isAdmin: false })
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov' })
    expect([401, 403]).toContain(res.status)
    expect(runLiveMock).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller', async () => {
    const app = createApp(db, { authenticated: false })
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov' })
    expect([401, 403]).toContain(res.status)
  })

  it('requires source_id', async () => {
    const app = createApp(db)
    const res = await request(app).post('/api/admin/crawl-coverage-actions/run-source').send({})
    expect(res.status).toBe(400)
    expect(runLiveMock).not.toHaveBeenCalled()
  })

  it('returns an honest 404 for a source_id with no Crawler OS registry entry', async () => {
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'not_a_real_crawler_os_source_id' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('source_not_crawlable')
    expect(runLiveMock).not.toHaveBeenCalled()
  })

  it('runs the most-recently-active profile scoped to just this source when no profile_id given', async () => {
    runLiveMock.mockResolvedValue({
      run: { sources: [{ source_id: 'grants_gov', outcome: 'FOUND', stored: 3, rejected: 1 }] },
      persisted: {},
    })
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.source_id).toBe('grants_gov')
    // profile-new is the most recently updated ACTIVE profile (profile-archived excluded).
    expect(res.body.profile_id).toBe('profile-new')
    expect(res.body.found).toBe(3)
    expect(res.body.rejected).toBe(1)

    expect(runLiveMock).toHaveBeenCalledTimes(1)
    const call = runLiveMock.mock.calls[0][0]
    expect(call.profileId).toBe('profile-new')
    expect(call.onlySourceIds).toEqual(['grants_gov'])
  })

  it('validates and uses an explicit profile_id', async () => {
    runLiveMock.mockResolvedValue({ run: { sources: [] }, persisted: {} })
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov', profile_id: 'profile-old' })

    expect(res.status).toBe(200)
    expect(res.body.profile_id).toBe('profile-old')
    expect(runLiveMock.mock.calls[0][0].profileId).toBe('profile-old')
  })

  it('404s when the explicit profile_id does not exist', async () => {
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov', profile_id: 'does-not-exist' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('profile_not_found')
    expect(runLiveMock).not.toHaveBeenCalled()
  })

  it('404s honestly when no active profile exists to scope the run to', async () => {
    await db.prepare("UPDATE profiles SET status = 'archived'").run()
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_active_profile')
    expect(runLiveMock).not.toHaveBeenCalled()
  })

  it('reports partial/timed_out instead of hanging when the crawl exceeds the budget', async () => {
    runLiveMock.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ run: { sources: [] }, persisted: {} }), 5000)
    }))
    const app = createApp(db)
    const res = await request(app)
      .post('/api/admin/crawl-coverage-actions/run-source')
      .send({ source_id: 'grants_gov' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.partial).toBe(true)
    expect(res.body.timed_out).toBe(true)
  })
})
