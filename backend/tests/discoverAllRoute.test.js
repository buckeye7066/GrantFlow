import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const triggerMock = vi.fn()
vi.mock('../services/crawlerOsDiscoveryJob.js', () => ({ enqueueCrawlerOsDiscovery: triggerMock }))

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
      success: true, engine: 'crawler-os', synchronous: false,
      jobs_enqueued: 1, job_ids: ['job-discovery'], profile_id: 'profile-owned',
    })
  })

  it('accepts a durable discovery job immediately and returns its exact progress receipt', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const res = await request(createApp(db, { userId: 'owner', role: 'user' }))
        .post('/api/real-crawlers/discover-all').send({ profile_id: 'profile-owned' })
      expect(res.status).toBe(202)
      expect(res.body).toMatchObject({ success: true, synchronous: false, job_ids: ['job-discovery'], jobs_enqueued: 1 })
      expect(res.body).not.toHaveProperty('stored')
      expect(triggerMock).toHaveBeenCalledExactlyOnceWith(db, 'profile-owned')
    } finally { db.close() }
  })

  it('returns failure when durable enqueue fails, never a successful zero-result scan', async () => {
    triggerMock.mockRejectedValue(new Error('database unavailable'))
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const res = await request(createApp(db, { userId: 'owner', role: 'user' }))
        .post('/api/real-crawlers/discover-all').send({ profile_id: 'profile-owned' })
      expect(res.status).toBe(500)
      expect(res.body).toMatchObject({ success: false, synchronous: false, jobs_enqueued: 0, job_ids: [] })
      expect(res.body).not.toHaveProperty('results')
    } finally { db.close() }
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
