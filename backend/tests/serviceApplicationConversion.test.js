/**
 * Guard for "Convert to Profile actually converts".
 *
 * The invisible-Anita bug (2026-07-06): the admin Convert button only PATCHed
 * service_applications.status='converted' — no profile was created or linked,
 * so the applicant was invisible in the admin profile list AND locked out of
 * login (prod /email/start only admits emails matching an existing profile).
 *
 * These tests pin the conversion choke point
 * (services/serviceApplicationConversion.js) and the boot-sweep net
 * (reconcileConvertedApplications, run by enforceInvariants.js).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  convertApplicationToProfile,
  reconcileConvertedApplications,
} from '../services/serviceApplicationConversion.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  db.pragma('foreign_keys = OFF')
  return db
}

function insertApplication(db, { id = crypto.randomUUID(), fullName, email, phone = null, category = 'individual', status = 'new', profileId = null } = {}) {
  db.prepare(
    `INSERT INTO service_applications (id, type, full_name, email, phone, client_category, selected_services, status, profile_id)
     VALUES (?, 'service_application', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, fullName, email, phone, category, status, profileId)
  return id
}

function insertProfile(db, { id = crypto.randomUUID(), displayName, email = null, status = 'active' } = {}) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, 'individual', ?)`,
  ).run(id, displayName, status)
  if (email) {
    db.prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, 'basic_information', ?)`,
    ).run(crypto.randomUUID(), id, JSON.stringify({ full_name: displayName, email }))
  }
  return id
}

describe('convertApplicationToProfile', () => {
  it('creates a real, visible, login-able profile when no existing profile matches', async () => {
    const db = makeDb()
    const appId = insertApplication(db, {
      fullName: 'Anita Mayes',
      email: 'nitaboatdrink@hotmail.com',
      phone: '8594200924',
    })
    const app = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)

    const result = await convertApplicationToProfile(db, app, { actor: 'test-admin' })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)

    // Profile exists, active, correctly named.
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.profileId)
    expect(profile).toBeTruthy()
    expect(profile.display_name).toBe('Anita Mayes')
    expect(profile.status).toBe('active')

    // basic_information carries email + phone + parsed name parts.
    const section = db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information'`)
      .get(result.profileId)
    const data = JSON.parse(section.data)
    expect(data.email).toBe('nitaboatdrink@hotmail.com')
    expect(data.phone).toBe('8594200924')
    expect(data.first_name).toBe('Anita')
    expect(data.last_name).toBe('Mayes')

    // Login access: the applicant email is on profile_emails (this is what the
    // production /email/start gate matches).
    const emails = db
      .prepare('SELECT email FROM profile_emails WHERE profile_id = ?')
      .all(result.profileId)
      .map((r) => r.email)
    expect(emails).toContain('nitaboatdrink@hotmail.com')

    // Application row is linked + converted.
    const updated = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)
    expect(updated.profile_id).toBe(result.profileId)
    expect(updated.status).toBe('converted')

    // All canonical sections were created (no missing-section crawler crashes).
    const sectionCount = db
      .prepare('SELECT COUNT(*) AS n FROM profile_sections WHERE profile_id = ?')
      .get(result.profileId).n
    expect(sectionCount).toBeGreaterThan(3)
    db.close()
  })

  it('links to the single existing profile matching by email instead of creating a duplicate', async () => {
    const db = makeDb()
    const existing = insertProfile(db, { displayName: 'Anita Mayes', email: 'nitaboatdrink@hotmail.com' })
    const appId = insertApplication(db, { fullName: 'Anita Mayes', email: 'nitaboatdrink@hotmail.com' })
    const app = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)

    const result = await convertApplicationToProfile(db, app)
    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.matchedBy).toBe('email')
    expect(result.profileId).toBe(existing)

    const profileCount = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n
    expect(profileCount).toBe(1)
    db.close()
  })

  it('reports ambiguity (and changes nothing) when multiple profiles match', async () => {
    const db = makeDb()
    insertProfile(db, { displayName: 'Anita Mayes', email: 'nitaboatdrink@hotmail.com' })
    insertProfile(db, { displayName: 'Anita M.', email: 'nitaboatdrink@hotmail.com' })
    const appId = insertApplication(db, { fullName: 'Anita Mayes', email: 'nitaboatdrink@hotmail.com' })
    const app = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)

    const result = await convertApplicationToProfile(db, app)
    expect(result.ok).toBe(false)
    expect(result.ambiguous).toBe(true)
    expect(result.candidates.length).toBe(2)

    const updated = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)
    expect(updated.profile_id).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(2)
    db.close()
  })
})

describe('reconcileConvertedApplications (boot-sweep net)', () => {
  it('heals a legacy converted-but-profileless row (the Anita case)', async () => {
    const db = makeDb()
    const appId = insertApplication(db, {
      fullName: 'Anita Mayes',
      email: 'nitaboatdrink@hotmail.com',
      status: 'converted',
      profileId: null,
    })

    const result = await reconcileConvertedApplications(db)
    expect(result.scanned).toBe(1)
    expect(result.repaired).toBe(1)
    expect(result.createdProfiles).toBe(1)
    expect(result.flagged).toBe(0)

    const updated = db.prepare('SELECT * FROM service_applications WHERE id = ?').get(appId)
    expect(updated.profile_id).toBeTruthy()
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(updated.profile_id)
    expect(profile.display_name).toBe('Anita Mayes')
    db.close()
  })

  it('never auto-creates for signup-type rows (link-only) — no duplicate clients', async () => {
    const db = makeDb()
    // A 'signup' row's profile was created at signup time; if it can't be
    // found by email/name, creating a fresh one would split the client's data.
    db.prepare(
      `INSERT INTO service_applications (id, type, full_name, email, status, profile_id)
       VALUES ('sg-1', 'signup', 'Ghost Signup', 'ghost@example.com', 'converted', NULL)`,
    ).run()

    const result = await reconcileConvertedApplications(db)
    expect(result.repaired).toBe(0)
    expect(result.createdProfiles).toBe(0)
    expect(result.flagged).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
    db.close()
  })

  it('links a signup-type row to its single name-matched profile', async () => {
    const db = makeDb()
    const profileId = insertProfile(db, { displayName: 'Liubov Samoylenko' })
    db.prepare(
      `INSERT INTO service_applications (id, type, full_name, email, status, profile_id)
       VALUES ('sg-2', 'signup', 'Liubov Samoylenko', 'owner@example.com', 'converted', NULL)`,
    ).run()

    const result = await reconcileConvertedApplications(db)
    expect(result.repaired).toBe(1)
    expect(result.createdProfiles).toBe(0)
    const row = db.prepare(`SELECT profile_id FROM service_applications WHERE id = 'sg-2'`).get()
    expect(row.profile_id).toBe(profileId)
    db.close()
  })

  it('is idempotent: already-linked converted rows are untouched', async () => {
    const db = makeDb()
    const profileId = insertProfile(db, { displayName: 'Linked Client', email: 'linked@example.com' })
    insertApplication(db, {
      fullName: 'Linked Client',
      email: 'linked@example.com',
      status: 'converted',
      profileId,
    })

    const result = await reconcileConvertedApplications(db)
    expect(result.scanned).toBe(1)
    expect(result.repaired).toBe(0)
    expect(result.createdProfiles).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(1)
    db.close()
  })
})
