import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const adminRouter = (await import('../routes/admin.js')).default

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { id: 'admin-1', userId: 'admin-1', role: 'admin', is_admin: 1 }
    req.ctx = { userId: 'admin-1', isAdmin: true }
    next()
  })
  app.use('/api/admin', adminRouter)
  return app
}

describe('admin login events route', () => {
  it('reads client_sign_in audit rows by action even when category drifted', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          created_at TEXT,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          severity TEXT DEFAULT 'info',
          user_id TEXT,
          profile_id TEXT,
          resource_type TEXT,
          resource_id TEXT,
          details TEXT,
          ip_address TEXT,
          user_agent TEXT
        );
      `)

      db.prepare(`
        INSERT INTO audit_logs (
          id, created_at, category, action, severity,
          user_id, profile_id, details, ip_address, user_agent
        ) VALUES (?, ?, ?, 'client_sign_in', 'info', ?, ?, ?, ?, ?)
      `).run(
        'login-old',
        '2026-06-23T12:00:00.000Z',
        'auth',
        'user-old',
        'profile-old',
        JSON.stringify({ identifier: 'old@example.test', method: 'email' }),
        '203.0.113.10',
        'old-agent',
      )

      db.prepare(`
        INSERT INTO audit_logs (
          id, created_at, category, action, severity,
          user_id, profile_id, details, ip_address, user_agent
        ) VALUES (?, ?, ?, 'client_sign_in', 'info', ?, ?, ?, ?, ?)
      `).run(
        'login-new',
        '2026-06-24T12:00:00.000Z',
        'user_activity',
        'user-new',
        'profile-new',
        JSON.stringify({ identifier: 'new@example.test', method: 'email' }),
        '203.0.113.20',
        'new-agent',
      )

      const res = await request(createApp(db)).get('/api/admin/login-events?limit=10')

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.degraded).toBe(true)
      expect(res.body.source_status.audit_logs.ok).toBe(true)
      expect(res.body.source_status.user_sessions.ok).toBe(false)
      expect(res.body.events.map((event) => event.identifier)).toEqual([
        'new@example.test',
        'old@example.test',
      ])
    } finally {
      db.close()
    }
  })

  it('returns 503 instead of pretending success when durable login sources fail', async () => {
    const db = new Database(':memory:')
    try {
      const res = await request(createApp(db)).get('/api/admin/login-events?limit=10')

      expect(res.status).toBe(503)
      expect(res.body.ok).toBe(false)
      expect(res.body.error).toBe('login_events_unavailable')
      expect(res.body.source_status.audit_logs.ok).toBe(false)
      expect(res.body.source_status.user_sessions.ok).toBe(false)
    } finally {
      db.close()
    }
  })
})
