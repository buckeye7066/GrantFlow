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

  it('does NOT double-count a login present in both audit_logs and user_sessions', async () => {
    // Regression: every fresh login writes a user_sessions row AND a client_sign_in
    // audit row in the same createSessionAndTokens call. The read path used to merge
    // both (dedup keyed only on event.id, which differs across the two sources), so
    // one sign-in rendered as two adjacent admin-panel rows — same client, same
    // instant — one with the real method badge and one labeled 'session'. The fix
    // threads the session id into the audit row (details.session_id + resource_id)
    // and drops the session duplicate. Historical (pre-audit) sessions still surface.
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
        CREATE TABLE user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          profile_id TEXT,
          issued_at TEXT,
          created_at TEXT,
          access_expires_at TEXT,
          refresh_expires_at TEXT,
          refresh_token_hash TEXT,
          ip_address TEXT,
          user_agent TEXT
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          primary_email TEXT,
          display_name TEXT,
          is_admin INTEGER DEFAULT 0
        );
      `)

      await db.prepare(
        `INSERT INTO users (id, primary_email, is_admin) VALUES ('u1', 'dup@example.test', 0)`,
      ).run()

      // A fresh login: one user_sessions row + one linked audit row (same session id).
      // This used to render as TWO events.
      await db.prepare(
        `INSERT INTO user_sessions (id, user_id, profile_id, issued_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', 'u1', 'profile-1', '2026-07-22T12:00:00.000Z', '203.0.113.7', 'ua-1')

      await db.prepare(
        `INSERT INTO audit_logs (id, created_at, category, action, severity, user_id, profile_id, resource_id, details, ip_address, user_agent)
         VALUES (?, ?, 'auth', 'client_sign_in', 'info', ?, ?, ?, ?, ?, ?)`,
      ).run(
        'audit-1',
        '2026-07-22T12:00:00.100Z',
        'u1',
        'profile-1',
        'sess-1',
        JSON.stringify({ identifier: 'dup@example.test', method: 'password', session_id: 'sess-1' }),
        '203.0.113.7',
        'ua-1',
      )

      // A historical session with NO matching audit row (before audit logging
      // existed) — still surfaced by the backfill.
      await db.prepare(
        `INSERT INTO user_sessions (id, user_id, profile_id, issued_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-old', 'u1', null, '2026-01-15T09:00:00.000Z', '198.51.100.5', 'ua-old')

      const res = await request(createApp(db)).get('/api/admin/login-events?limit=50')

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      // Both durable sources healthy — NOT degraded.
      expect(res.body.degraded).toBe(false)
      expect(res.body.source_status.audit_logs.ok).toBe(true)
      expect(res.body.source_status.user_sessions.ok).toBe(true)

      // Exactly TWO events: the audited login (real method) + one backfilled
      // historical session. The duplicate session for 'sess-1' is suppressed.
      const ids = res.body.events.map((e) => e.id)
      expect(ids).toHaveLength(2)
      expect(ids).toContain('audit-1')
      expect(ids).toContain('session:sess-old')

      const audited = res.body.events.find((e) => e.id === 'audit-1')
      expect(audited.method).toBe('password')            // real method wins
      expect(audited.session_id).toBe('sess-1')          // link surfaced
      expect(audited.identifier).toBe('dup@example.test')

      // The duplicate 'session:sess-1' row MUST NOT appear.
      expect(ids).not.toContain('session:sess-1')
    } finally {
      db.close()
    }
  })
})
