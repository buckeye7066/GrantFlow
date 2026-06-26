/**
 * Regression test for POST /api/grant-monitoring/check.
 *
 * Production (Postgres) returned 500 because the deadline-event INSERT bound a
 * literal `0` to the BOOLEAN `acknowledged` column. SQLite accepts `0` for a
 * boolean, so the bug never surfaced in dev/tests; Postgres rejects it
 * ("column \"acknowledged\" is of type boolean but expression is of type
 * integer"). The fix omits acknowledged/acknowledged_at and lets the DB
 * defaults apply. These tests lock the route's happy path + dedup behaviour and
 * run through the production-faithful sqlite wrapper.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const express = (await import('express')).default
const request = (await import('supertest')).default
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const grantMonitoringRouter = (await import('../routes/grantMonitoring.js')).default

function isoInDays(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      title TEXT,
      status TEXT,
      deadline DATE,
      match_score INTEGER
    );
    CREATE TABLE grant_monitoring_alerts (
      id TEXT PRIMARY KEY,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      alert_type TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      threshold_days INTEGER,
      notification_methods TEXT DEFAULT '[]'
    );
    CREATE TABLE grant_monitoring_logs (
      id TEXT PRIMARY KEY,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      grant_id TEXT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','high','critical')),
      event_data TEXT DEFAULT '{}',
      acknowledged BOOLEAN DEFAULT FALSE,
      acknowledged_at DATETIME
    );
  `)
  return { sqlite, db: wrapSqlite(sqlite) }
}

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.ctx = { userId: 'admin-user', isAdmin: true }
    next()
  })
  app.use('/api/grant-monitoring', grantMonitoringRouter)
  return app
}

describe('POST /api/grant-monitoring/check', () => {
  let sqlite
  let db
  let app

  beforeEach(() => {
    ;({ sqlite, db } = makeDb())
    sqlite.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run('org1', 'Org One')
    sqlite
      .prepare(
        `INSERT INTO grants (id, organization_id, title, status, deadline, match_score)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('g1', 'org1', 'Soon Due Grant', 'interested', isoInDays(5), 80)
    app = makeApp(db)
  })

  it('returns 200 and logs a deadline_approaching event (no Postgres boolean 500)', async () => {
    const res = await request(app).post('/api/grant-monitoring/check').send({})
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.events_logged).toBe(1)

    const rows = sqlite.prepare('SELECT * FROM grant_monitoring_logs').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('deadline_approaching')
    expect(rows[0].severity).toBe('critical') // <= 7 days
    // Default applied (FALSE/0) — the value the prod INSERT used to set wrong.
    expect(Boolean(rows[0].acknowledged)).toBe(false)
  })

  it('dedupes repeat events within 24h (second run logs nothing)', async () => {
    await request(app).post('/api/grant-monitoring/check').send({})
    const res2 = await request(app).post('/api/grant-monitoring/check').send({})
    expect(res2.status).toBe(200)
    expect(res2.body.events_logged).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM grant_monitoring_logs').get().n).toBe(1)
  })

  it('skips the event when the org disabled deadline_approaching alerts', async () => {
    sqlite
      .prepare(
        `INSERT INTO grant_monitoring_alerts (id, organization_id, alert_type, enabled, threshold_days)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('a1', 'org1', 'deadline_approaching', 0, 14)
    const res = await request(app).post('/api/grant-monitoring/check').send({})
    expect(res.status).toBe(200)
    expect(res.body.events_logged).toBe(0)
  })
})
