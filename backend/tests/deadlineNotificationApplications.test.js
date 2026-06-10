import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { generateDeadlineNotifications } from '../services/deadlineNotificationService.js'

// Production-readiness fix: the application tracker (grant_applications) stores a
// deadline_date that was previously unwatched, so users tracking applications got
// no deadline alerts. These tests pin the new coverage.

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, primary_phone TEXT);
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      message TEXT NOT NULL, data TEXT, read INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', grant_name TEXT, funder_name TEXT, deadline_date TEXT
    );
    -- Empty pipeline tables so the grants-side query returns 0 cleanly.
    CREATE TABLE grants (id TEXT PRIMARY KEY, status TEXT, funding_opportunity_id TEXT, title TEXT, profile_id TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, deadline TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    INSERT INTO users (id, primary_email) VALUES ('u1', 'u1@example.org');
  `)
  return db
}

// A deadline exactly N days out, stored as a full ISO instant so both the SQL
// range filter and the JS day-diff agree regardless of the runner's timezone.
function deadlineInDays(n) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d.toISOString()
}

function addApplication(db, { id, status = 'in_progress', grant_name = 'Test Grant', days }) {
  db.prepare(
    `INSERT INTO grant_applications (id, user_id, status, grant_name, deadline_date) VALUES (?, 'u1', ?, ?, ?)`,
  ).run(id, status, grant_name, deadlineInDays(days))
}

describe('deadline notifications for the application tracker', () => {
  it('notifies on an active application deadline at a 3-day threshold', async () => {
    const db = makeDb()
    try {
      addApplication(db, { id: 'a1', grant_name: 'Rural Fire Grant', days: 3 })
      const res = await generateDeadlineNotifications(db)
      expect(res.created).toBe(1)
      const rows = db.prepare("SELECT title, type, data FROM notifications WHERE user_id='u1'").all()
      expect(rows).toHaveLength(1)
      expect(rows[0].type).toBe('deadline_approaching')
      expect(rows[0].title).toContain('Rural Fire Grant')
      expect(JSON.parse(rows[0].data).application_id).toBe('a1')
    } finally {
      db.close()
    }
  })

  it('dedups: a second run the same day creates nothing new', async () => {
    const db = makeDb()
    try {
      addApplication(db, { id: 'a1', days: 1 })
      const first = await generateDeadlineNotifications(db)
      const second = await generateDeadlineNotifications(db)
      expect(first.created).toBe(1)
      expect(second.created).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('ignores terminal-status applications (awarded/denied/withdrawn)', async () => {
    const db = makeDb()
    try {
      addApplication(db, { id: 'a1', status: 'awarded', days: 3 })
      addApplication(db, { id: 'a2', status: 'denied', days: 1 })
      addApplication(db, { id: 'a3', status: 'withdrawn', days: 7 })
      const res = await generateDeadlineNotifications(db)
      expect(res.created).toBe(0)
    } finally {
      db.close()
    }
  })

  it('ignores deadlines that are not on a 1/3/7-day threshold', async () => {
    const db = makeDb()
    try {
      addApplication(db, { id: 'a1', days: 5 })
      const res = await generateDeadlineNotifications(db)
      expect(res.created).toBe(0)
    } finally {
      db.close()
    }
  })

  it('does not crash when grant_applications is absent (older DBs)', async () => {
    const db = new Database(':memory:')
    db.dialect = 'sqlite'
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, primary_phone TEXT);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT, message TEXT, data TEXT, read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP);
    `)
    try {
      const res = await generateDeadlineNotifications(db)
      expect(res.created).toBe(0)
    } finally {
      db.close()
    }
  })
})
