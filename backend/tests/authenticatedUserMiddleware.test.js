import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import applicationsRouter from '../routes/applications.js'
import activityRouter from '../routes/activity.js'
import Database from 'better-sqlite3'

function withTimeout(promise, ms = 1000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('requireAuthenticatedUserMiddleware', () => {
  it('returns 401 promptly for unauthenticated requests', async () => {
    const app = express()
    const router = express.Router()
    router.use(requireAuthenticatedUserMiddleware)
    router.get('/probe', (_req, res) => res.status(200).json({ ok: true }))
    app.use('/test', router)

    const response = await withTimeout(request(app).get('/test/probe'), 1000)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Authentication required' })
  })

  it('calls next and reaches handlers for authenticated requests', async () => {
    const app = express()
    const router = express.Router()
    router.use((req, _res, next) => {
      req.user = { id: 'user-1', role: 'user' }
      next()
    })
    router.use(requireAuthenticatedUserMiddleware)
    router.get('/probe', (req, res) => res.status(200).json({ ok: true, userId: req.user.id }))
    app.use('/test', router)

    const response = await withTimeout(request(app).get('/test/probe'), 1000)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, userId: 'user-1' })
  })
})

describe('authenticated routes protected by requireAuthenticatedUserMiddleware', () => {
  it('POST /api/applications/prepare responds promptly for an authenticated request', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE grants (id TEXT PRIMARY KEY, organization_id TEXT, title TEXT NOT NULL);
        INSERT INTO organizations (id, name) VALUES ('org-1', 'Test Org');
        INSERT INTO grants (id, organization_id, title) VALUES ('grant-1', 'org-1', 'Test Grant');
      `)

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        req.user = { id: 'user-1', userId: 'user-1', role: 'user' }
        req.ctx = { userId: 'user-1', isAdmin: true }
        req.db = db
        next()
      })
      app.use('/api/applications', applicationsRouter)

      const response = await withTimeout(
        request(app)
          .post('/api/applications/prepare')
          .send({ grantId: 'grant-1', organizationId: 'org-1' }),
        1000,
      )

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        grant_id: 'grant-1',
        organization_id: 'org-1',
        status: 'draft',
      })
    } finally {
      db.close()
    }
  })

  it('POST /api/activity/page-view responds promptly for an authenticated request', async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', userId: 'user-1', role: 'user' }
      req.ctx = { userId: 'user-1', activeProfileId: 'profile-1', email: 'user@example.com' }
      req.db = null
      next()
    })
    app.use('/api/activity', activityRouter)

    const response = await withTimeout(
      request(app)
        .post('/api/activity/page-view')
        .send({ path: '/dashboard', title: 'Dashboard' }),
      1000,
    )

    expect(response.status).toBe(204)
  })
})
