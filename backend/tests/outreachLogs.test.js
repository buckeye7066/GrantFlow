import express from 'express'
import request from 'supertest'
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import outreachRouter from '../routes/outreachLogs.js'

function makeApp(sqlite, ctx) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { role: 'user', userId: 'u1' }
    req.ctx = ctx ?? { userId: 'u1', activeProfileId: null, isAdmin: false }
    req.db = sqlite
    next()
  })
  app.use('/api/outreach-logs', outreachRouter)
  return app
}

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
  `)
  return sqlite
}

describe('GET /api/outreach-logs', () => {
  it('returns 200 with an empty result when there is no profile context (was 400 on initial load)', async () => {
    const sqlite = freshDb()
    try {
      const res = await request(makeApp(sqlite)).get('/api/outreach-logs')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ profile_id: null, organization_id: null, items: [] })
    } finally {
      sqlite.close()
    }
  })

  it('honors the X-Profile-Id header (the frontend contract) and returns that profile\'s logs', async () => {
    const sqlite = freshDb()
    try {
      sqlite.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run('o1', 'Org One')
      sqlite.prepare('INSERT INTO profiles (id, user_id, organization_id) VALUES (?, ?, ?)').run('p1', 'u1', 'o1')
      // The DB-backed accessible set is what requestContext computes for u1 (who
      // owns p1); the route decides access from it, not from ctx.userId.
      const app = makeApp(sqlite, { userId: 'u1', activeProfileId: 'p1', isAdmin: false, accessibleProfileIds: new Set(['p1']) })

      // Create a log (POST resolves profile_id from the body)...
      const created = await request(app)
        .post('/api/outreach-logs')
        .send({ profile_id: 'p1', funder: 'Acme Foundation', method: 'email', subject: 'Intro' })
      expect(created.status).toBe(201)

      // ...and read it back via the X-Profile-Id header (no query param).
      const res = await request(app).get('/api/outreach-logs').set('X-Profile-Id', 'p1')
      expect(res.status).toBe(200)
      expect(res.body.profile_id).toBe('p1')
      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0].funder).toBe('Acme Foundation')
    } finally {
      sqlite.close()
    }
  })
})
