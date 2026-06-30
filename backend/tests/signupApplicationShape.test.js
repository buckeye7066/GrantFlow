/**
 * Guard for "new signups appear under admin → Applications".
 *
 * Self-serve signups create a profile but previously wrote NO service_applications
 * row, so the Applications tab stayed empty even as users joined. Profile creation
 * now inserts a 'signup' application linked to the profile. This test pins the
 * INSERT column shape against the real schema and confirms the admin list query
 * surfaces the row (so a schema/column drift fails CI, not prod).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  db.pragma('foreign_keys = OFF') // service_applications.profile_id is informational here
  return db
}

// Mirror of the INSERT in backend/routes/profiles.js (signup application).
const SIGNUP_INSERT = `
  INSERT INTO service_applications (id, type, full_name, email, status, profile_id)
  VALUES (?, 'signup', ?, ?, 'new', ?)
`
// Mirror of the admin list read in backend/routes/serviceApplication.js.
const LIST = `SELECT * FROM service_applications ORDER BY created_at DESC LIMIT 50`

describe('signup -> service_applications', () => {
  it('inserts a signup application with columns that exist on the real schema', () => {
    const db = makeDb()
    expect(() =>
      db.prepare(SIGNUP_INSERT).run('app-1', 'Jane Applicant', 'jane@example.com', 'profile-1'),
    ).not.toThrow()
    db.close()
  })

  it('surfaces the new signup in the admin Applications list as a "new" row', () => {
    const db = makeDb()
    db.prepare(SIGNUP_INSERT).run('app-1', 'Jane Applicant', 'jane@example.com', 'profile-1')
    const rows = db.prepare(LIST).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'signup',
      full_name: 'Jane Applicant',
      email: 'jane@example.com',
      status: 'new',
      profile_id: 'profile-1',
    })
    db.close()
  })

  it('also lists only the "new" status when filtered (the badge count source)', () => {
    const db = makeDb()
    db.prepare(SIGNUP_INSERT).run('app-1', 'Jane', 'jane@example.com', 'profile-1')
    db.prepare(SIGNUP_INSERT).run('app-2', 'John', 'john@example.com', 'profile-2')
    const newRows = db.prepare(`SELECT * FROM service_applications WHERE status = 'new'`).all()
    expect(newRows).toHaveLength(2)
    db.close()
  })
})
