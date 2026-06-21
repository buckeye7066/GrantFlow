/**
 * POST /api/real-crawlers/discover-all — on-demand full relevance-gated fleet.
 *
 * Pins the route contract:
 *   - An authorized profile owner gets the enqueued summary
 *     { jobs_enqueued, crawler_types } from triggerAutoDiscoveryCrawlers.
 *   - A user with no access to the profile is rejected (403), profile-scoped, no
 *     cross-tenant dispatch.
 *   - Missing profile_id → 400.
 *
 * triggerAutoDiscoveryCrawlers is mocked so the test asserts on the route's
 * auth + passthrough behavior, not on real crawl dispatch.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const triggerMock = vi.fn(async () => ({
  jobs_enqueued: 5,
  crawler_types: ['local', 'comprehensive', 'government_funding', 'special_needs', 'ecf_hcbs'],
  job_ids: ['j1', 'j2', 'j3', 'j4', 'j5'],
}))

vi.mock('../services/autoDiscoveryCrawlers.js', () => ({
  triggerAutoDiscoveryCrawlers: triggerMock,
}))

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
    triggerMock.mockClear()
  })

  it('authorized owner gets the enqueued summary and the selector is invoked', async () => {
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
      expect(res.body.jobs_enqueued).toBe(5)
      expect(res.body.crawler_types).toContain('comprehensive')
      expect(triggerMock).toHaveBeenCalledTimes(1)
      expect(triggerMock.mock.calls[0][1]).toBe('profile-owned')
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
})
