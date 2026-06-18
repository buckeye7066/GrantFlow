import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import activityRouter from '../routes/activity.js'
import { queryAuditLogs, AUDIT_CATEGORIES } from '../services/auditService.js'

function withTimeout(promise, ms = 1000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', userId: 'user-1', role: 'user' }
    req.ctx = { userId: 'user-1', activeProfileId: 'profile-1', email: 'user@example.com' }
    req.db = db
    next()
  })
  app.use('/api/activity', activityRouter)
  return app
}

describe('page-view analytics: accept, persist, and display', () => {
  it('persists a page view (204) and the recorded row is retrievable by the admin read path', async () => {
    const db = new Database(':memory:')
    try {
      const app = makeApp(db)

      const response = await withTimeout(
        request(app)
          .post('/api/activity/page-view')
          .send({ path: '/Calendar', title: 'Calendar', referrer: 'https://app.example.com/Dashboard' }),
        1000,
      )

      // Endpoint accepts the event.
      expect(response.status).toBe(204)

      // Persisted: a row exists in audit_logs (auto-created by the service).
      const rows = db.prepare('SELECT category, action, details FROM audit_logs').all()
      expect(rows).toHaveLength(1)
      // The writer records page views under USER_ACTIVITY (not AUTH).
      expect(rows[0].category).toBe(AUDIT_CATEGORIES.USER_ACTIVITY)
      expect(rows[0].action).toBe('client_page_view')

      // Displayed: the admin "Page views (recent)" panel reads by the unique
      // `action` discriminator (NOT category). The persisted view must surface here.
      const shown = await queryAuditLogs(db, { action: 'client_page_view', limit: 50 })
      expect(shown.logs).toHaveLength(1)
      expect(shown.logs[0].details).toMatchObject({
        path: '/Calendar',
        title: 'Calendar',
        referrer: 'https://app.example.com/Dashboard',
      })
    } finally {
      db.close()
    }
  })

  it('regression: filtering page views by category AUTH (the old read) misses them', async () => {
    const db = new Database(':memory:')
    try {
      const app = makeApp(db)

      await withTimeout(
        request(app).post('/api/activity/page-view').send({ path: '/Dashboard', title: 'Home' }),
        1000,
      )

      // The previous implementation filtered on category 'auth' — which silently
      // dropped every page view (they are written under 'user_activity').
      const byAuthCategory = await queryAuditLogs(db, {
        category: AUDIT_CATEGORIES.AUTH,
        action: 'client_page_view',
        limit: 50,
      })
      expect(byAuthCategory.logs).toHaveLength(0)

      // The fixed read (action only) finds it.
      const byAction = await queryAuditLogs(db, { action: 'client_page_view', limit: 50 })
      expect(byAction.logs).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('degrades quietly to 204 (never 503) when the audit write fails', async () => {
    // No db wired up — logAuditEvent cannot persist, but analytics must not break
    // the client request, and the client must never see a 503 to spam-retry.
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
      request(app).post('/api/activity/page-view').send({ path: '/Dashboard' }),
      1000,
    )

    expect(response.status).toBe(204)
  })
})
