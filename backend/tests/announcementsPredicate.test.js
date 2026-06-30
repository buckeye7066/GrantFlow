import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

// Isolate the test to the dialect-specific SQL predicate: stub access control
// so the route reaches its announcements SELECT deterministically.
vi.mock('../utils/accessControl.js', () => ({
  requireAuthenticatedUser: (req) => req.user,
  getAccessibleProfileIds: async () => [],
}))

const announcementsRouter = (await import('../routes/announcements.js')).default

// Fake db that records every SQL it's asked to prepare.
function recordingDb(dialect) {
  const sqls = []
  return {
    db: {
      dialect,
      prepare(sql) {
        sqls.push(sql)
        return { all: async () => [], run: async () => ({}), get: async () => null }
      },
    },
    sqls,
  }
}

function appWith(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { id: 'u1', userId: 'u1', role: 'user' }
    next()
  })
  app.use('/api', announcementsRouter)
  return app
}

describe('announcements pending — active predicate is dialect-safe', () => {
  it('postgres uses CAST(active AS BOOLEAN) IS TRUE (not bare "active IS TRUE")', async () => {
    const { db, sqls } = recordingDb('postgres')
    const res = await request(appWith(db)).get('/api/announcements/pending')
    expect(res.status).toBe(200)
    const sel = sqls.find((s) => /FROM announcements/i.test(s))
    expect(sel).toBeTruthy()
    expect(sel).toContain('CAST(active AS BOOLEAN) IS TRUE')
    // Regression guard: the integer column in prod made the bare form throw
    // "argument of IS TRUE must be type boolean, not type integer".
    expect(sel).not.toMatch(/WHERE\s+active IS TRUE/i)
  })

  it('sqlite uses active = 1', async () => {
    const { db, sqls } = recordingDb('sqlite')
    const res = await request(appWith(db)).get('/api/announcements/pending')
    expect(res.status).toBe(200)
    const sel = sqls.find((s) => /FROM announcements/i.test(s))
    expect(sel).toBeTruthy()
    expect(sel).toContain('active = 1')
  })
})
