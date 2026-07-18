/**
 * SECURITY REGRESSION (privilege via stale token claim).
 *
 * GET /api/reminders previously took the DB-wide (unscoped) path whenever the
 * DEPRECATED isAdminUser(user) token check returned true — BEFORE consulting the
 * DB-backed admin flag. A user demoted in users.is_admin but still holding an
 * unexpired JWT with role:'admin' would thus read every tenant's grant deadlines
 * and milestones. The route now derives scope solely from the DB-backed
 * getAccessibleOrganizationIds, so a demoted admin is scoped to their own org.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const remindersRouter = (await import('../routes/reminders.js')).default

function isoDaysFromToday(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, organization_id TEXT, status TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, title TEXT, funder TEXT, deadline TEXT,
      status TEXT, amount_requested REAL, organization_id TEXT
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, due_date TEXT,
      type TEXT, reminder_days INTEGER, grant_id TEXT,
      organization_id TEXT, completed INTEGER DEFAULT 0
    );
  `)
  // A user who was demoted: DB says NOT admin.
  db.prepare(`INSERT INTO users (id, is_admin) VALUES ('demoted', 0)`).run()
  db.prepare(`INSERT INTO organizations (id, name) VALUES ('orgA','Org A'), ('orgB','Org B')`).run()
  db.prepare(`INSERT INTO profiles (id, user_id, created_by, organization_id, status) VALUES ('pA','demoted','demoted','orgA','active')`).run()
  const soon = isoDaysFromToday(3)
  db.prepare(
    `INSERT INTO grants (id, title, status, deadline, organization_id)
     VALUES ('gA','Grant A','discovered', ?, 'orgA'), ('gB','Grant B','discovered', ?, 'orgB')`,
  ).run(soon, soon)
  db.prepare(
    `INSERT INTO milestones (id, title, due_date, organization_id, completed)
     VALUES ('mA','Org A milestone', ?, 'orgA', 0), ('mB','Org B milestone', ?, 'orgB', 0)`,
  ).run(soon, soon)
  return db
}

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    // Simulate a stale JWT that still claims admin, though users.is_admin = 0.
    req.user = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'demoted' }
    next()
  })
  app.use('/', remindersRouter)
  return app
}

describe('reminders: demoted admin with a stale role:admin JWT is DB-scoped', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('returns only the caller org’s deadlines + milestones, not every tenant’s', async () => {
    const res = await request(makeApp(db)).get('/')
    expect(res.status).toBe(200)
    const grantTitles = (res.body.urgentDeadlines || []).map((d) => d.title).sort()
    const msTitles = (res.body.upcomingMilestones || []).map((m) => m.title).sort()
    expect(grantTitles).toEqual(['Grant A'])
    expect(msTitles).toEqual(['Org A milestone'])
  })
})
