/**
 * Regression tests for fetchReminderSnapshot org scoping.
 *
 * The milestone query injects the org-scope `IN (?)` placeholders into the SQL
 * BEFORE the two due_date placeholders, so the org ids must come FIRST in the
 * positional params array. A previous fix appended them at the end, shifting
 * every binding (dates bound to the org filter, org ids bound to the date
 * range) — org-scoped users saw zero/garbage milestones or a Postgres 500.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { fetchReminderSnapshot } = await import('../routes/reminders.js')

function isoDaysFromToday(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
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
  db.prepare(`INSERT INTO organizations (id, name) VALUES ('orgA', 'Org A'), ('orgB', 'Org B')`).run()
  return db
}

describe('fetchReminderSnapshot org scoping (milestones)', () => {
  let db
  const due = isoDaysFromToday(5)

  beforeEach(() => {
    db = makeDb()
    db.prepare(
      `INSERT INTO milestones (id, title, due_date, organization_id, completed)
       VALUES ('mA', 'Org A milestone', ?, 'orgA', 0),
              ('mB', 'Org B milestone', ?, 'orgB', 0)`
    ).run(due, due)
  })

  it('returns only the scoped org’s milestones (params bound in placeholder order)', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, { organizationIds: ['orgA'] })
    const titles = snapshot.upcomingMilestones.map((m) => m.title)
    expect(titles).toEqual(['Org A milestone'])
  })

  it('scopes via the grant’s organization when the milestone has none (COALESCE path)', async () => {
    db.prepare(
      `INSERT INTO grants (id, title, status, organization_id) VALUES ('gA', 'Grant A', 'discovered', 'orgA')`
    ).run()
    db.prepare(
      `INSERT INTO milestones (id, title, due_date, grant_id, organization_id, completed)
       VALUES ('mG', 'Grant-linked milestone', ?, 'gA', NULL, 0)`
    ).run(due)
    const snapshot = await fetchReminderSnapshot(db, 30, { organizationIds: ['orgA'] })
    const ids = snapshot.upcomingMilestones.map((m) => m.id).sort()
    expect(ids).toEqual(['mA', 'mG'])
  })

  it('returns all orgs’ milestones when unscoped', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, {})
    expect(snapshot.upcomingMilestones).toHaveLength(2)
  })

  it('supports multiple org ids', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, { organizationIds: ['orgA', 'orgB'] })
    expect(snapshot.upcomingMilestones).toHaveLength(2)
  })
})

/**
 * SECURITY REGRESSION (cross-tenant leak): an EMPTY organizationIds array means
 * "the caller has access to no org" and MUST return nothing — it must never be
 * treated the same as an omitted option (admin/system, DB-wide). The route bug
 * was passing `[]` for every non-admin (a Set failed `Array.isArray`), which
 * this function then read as "no filter" and leaked every tenant's rows.
 */
describe('fetchReminderSnapshot empty-scope leak guard', () => {
  let db
  const due = isoDaysFromToday(5)
  const soon = isoDaysFromToday(3)

  beforeEach(() => {
    db = makeDb()
    db.prepare(
      `INSERT INTO milestones (id, title, due_date, organization_id, completed)
       VALUES ('mA', 'Org A milestone', ?, 'orgA', 0),
              ('mB', 'Org B milestone', ?, 'orgB', 0)`
    ).run(due, due)
    db.prepare(
      `INSERT INTO grants (id, title, status, deadline, organization_id)
       VALUES ('gA', 'Grant A', 'discovered', ?, 'orgA'),
              ('gB', 'Grant B', 'discovered', ?, 'orgB')`
    ).run(soon, soon)
  })

  it('returns NO milestones when scoped to an empty org set', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, { organizationIds: [] })
    expect(snapshot.upcomingMilestones).toEqual([])
  })

  it('returns NO deadlines when scoped to an empty org set', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, { organizationIds: [] })
    expect(snapshot.urgentDeadlines).toEqual([])
  })

  it('still returns everything when the option is OMITTED (admin/system path)', async () => {
    const snapshot = await fetchReminderSnapshot(db, 30, {})
    expect(snapshot.upcomingMilestones).toHaveLength(2)
    expect(snapshot.urgentDeadlines).toHaveLength(2)
  })
})
