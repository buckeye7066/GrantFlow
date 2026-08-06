/**
 * POST /api/real-crawlers/discover-all — synchronous Crawler OS alias.
 *
 * Pins the route contract:
 *   - An authorized profile owner gets persisted counts and source receipts
 *     from the synchronous Crawler OS compatibility entrypoint.
 *   - A returned Crawler OS error is an HTTP failure, never success:true/zero.
 *   - A user with no access to the profile is rejected (403), profile-scoped, no
 *     cross-tenant dispatch.
 *   - Missing profile_id → 400.
 *
 * triggerAutoDiscoveryCrawlers is mocked so the test asserts on the route's
 * auth + receipt/error contract, not on external crawl execution.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const triggerMock = vi.fn(async () => ({
  engine: 'crawler-os',
  synchronous: true,
  jobs_enqueued: 1,
  crawler_types: ['grants-gov', 'ohio-benefits'],
  stored: 2,
  matches: 3,
  planned: 4,
  rejected: 1,
  recommendations: 2,
  sources: [
    { source_id: 'grants-gov', stored: 1, rejected: 1 },
    { source_id: 'ohio-benefits', stored: 1, rejected: 0 },
  ],
}))

vi.mock('../services/crawlerOsCompatibility.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, triggerAutoDiscoveryCrawlers: triggerMock }
})

const realCrawlersRouter = (await import('../routes/realCrawlers.js')).default

function seedSchema(db) {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, status TEXT DEFAULT 'active');
    INSERT INTO users (id, primary_email) VALUES ('owner', 'owner@test.local'), ('intruder', 'intruder@test.local');
    INSERT INTO profiles (id, user_id) VALUES ('profile-owned', 'owner');
  `)
}

function createApp(db, user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.db = db
    req.ctx = { userId: user?.userId, isAdmin: false }
    next()
  })
  app.use('/api/real-crawlers', realCrawlersRouter)
  return app
}

describe('POST /api/real-crawlers/discover-all', () => {
  beforeEach(() => {
    triggerMock.mockReset()
    triggerMock.mockResolvedValue({
      engine: 'crawler-os',
      synchronous: true,
      jobs_enqueued: 1,
      crawler_types: ['grants-gov', 'ohio-benefits'],
      stored: 2,
      matches: 3,
      planned: 4,
      rejected: 1,
      recommendations: 2,
      sources: [
        { source_id: 'grants-gov', stored: 1, rejected: 1 },
        { source_id: 'ohio-benefits', stored: 1, rejected: 0 },
      ],
    })
  })

  it('returns synchronous persisted counts and source receipts to the authorized owner', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/discover-all')
        .send({ profile_id: 'profile-owned' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.profile_id).toBe('profile-owned')
      expect(res.body.engine).toBe('crawler-os')
      expect(res.body.synchronous).toBe(true)
      expect(res.body.jobs_enqueued).toBe(0)
      expect(res.body.stored).toBe(2)
      expect(res.body.matches).toBe(3)
      expect(res.body.crawler_types).toEqual(['grants-gov', 'ohio-benefits'])
      expect(res.body.sources).toEqual([
        { source_id: 'grants-gov', stored: 1, rejected: 1 },
        { source_id: 'ohio-benefits', stored: 1, rejected: 0 },
      ])
      expect(res.body.source_receipts).toEqual(res.body.sources)
      expect(triggerMock).toHaveBeenCalledTimes(1)
      expect(triggerMock.mock.calls[0][1]).toBe('profile-owned')
    } finally {
      db.close()
    }
  })

  it('returns non-2xx success:false when Crawler OS reports a persistence failure', async () => {
    triggerMock.mockResolvedValue({
      engine: 'crawler-os',
      synchronous: true,
      error: 'profile match persistence failed',
    })
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/discover-all')
        .send({ profile_id: 'profile-owned' })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.body).toMatchObject({
        success: false,
        engine: 'crawler-os',
        synchronous: true,
        stored: 0,
        matches: 0,
        sources: [],
      })
      expect(res.body).not.toHaveProperty('results')
      expect(triggerMock).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('rejects a user with no access to the profile (403) and never dispatches', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'intruder', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/discover-all')
        .send({ profile_id: 'profile-owned' })

      expect(res.status).toBe(403)
      expect(triggerMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects a missing profile_id with 400', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/discover-all')
        .send({})

      expect(res.status).toBe(400)
      expect(triggerMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects an unknown profile and never invokes Crawler OS', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/discover-all')
        .send({ profile_id: 'profile-missing' })

      expect(res.status).toBe(403)
      expect(triggerMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
