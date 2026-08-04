/**
 * POST /api/grants — a profile-scoped manual create is SCORED through the
 * canonical engine when the caller supplies no score (2026-08-04).
 *
 * PREREQUISITE PIN: profile_id must be in ALLOWED_GRANT_COLUMNS. It was not —
 * sanitizeColumns silently STRIPPED it from every manual create, so the
 * route's own dismissal gate, duplicate guard, and this scoring block were
 * ALL dead code (sanitizedData.profile_id was always undefined) and every
 * "profile-scoped" manual grant landed org-only. The first test here fails on
 * that omission, not just on a deleted scoring block. The companion guard:
 * a profile-scoped create is refused when the profile belongs to a DIFFERENT
 * organization (G4/G8 — a grant's org must match its profile's org).
 *
 * Unscored manual/import rows are exactly what migrations 063/064/0056/0057
 * later stamped with match_decision='review' + matched_needs
 * '["general funding support"]' — the prod junk signature the score-backfill
 * net now repairs. The write-side rule: never BLOCK a manual create on match
 * quality (user-created rows are protected; NULL score is never junk), but
 * never persist an UNSCORED profile row when a canonical score is computable.
 * Caller-supplied scores win; a scoring failure leaves the row unscored for
 * the boot backfill net.
 */

import express from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const grantsRouter = (await import('../routes/grants.js')).default

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT '2026-01-01'
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, created_at TEXT DEFAULT '2026-01-01',
      organization_id TEXT, profile_id TEXT, funding_opportunity_id TEXT,
      title TEXT, funder TEXT, deadline TEXT, status TEXT DEFAULT 'discovered',
      priority TEXT, amount_requested REAL, amount_awarded REAL,
      amount_min REAL, amount_max REAL, application_url TEXT, url TEXT,
      submitted_date TEXT, award_date TEXT,
      fingerprint TEXT, fingerprint_version INTEGER,
      match_score REAL, match_decision TEXT, matched_needs TEXT,
      match_explanation TEXT, matcher_version TEXT, evaluated_at TEXT,
      match_reasons TEXT, notes TEXT, updated_at TEXT DEFAULT '2026-01-01'
    );
    INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type)
      VALUES ('p-1', 'u-1', 'org-1', 'Anastasia White', 'student');
    INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type)
      VALUES ('p-other-org', 'u-2', 'org-2', 'Someone Else', 'student');
    INSERT INTO profile_sections (profile_id, section_key, data) VALUES
      ('p-1', 'basic_information', '{"first_name":"Anastasia","last_name":"White","state":"TN","city":"Murfreesboro"}'),
      ('p-1', 'education', '{"current_institution":"Middle Tennessee State University","intended_major":"Forensic Science"}');
  `)
  return db
}

function appWith(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { role: 'admin', userId: 'u-1' }
    req.ctx = { isAdmin: true }
    next()
  })
  app.use('/api/grants', grantsRouter)
  return app
}

describe('POST /api/grants — manual-create canonical scoring', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('scores a profile-scoped create through the canonical engine and stamps manual-create-scored', async () => {
    const res = await request(appWith(db))
      .post('/api/grants')
      .send({
        title: 'Tennessee HOPE Scholarship',
        organization_id: 'org-1',
        profile_id: 'p-1',
        funder: 'Tennessee Student Assistance Corporation',
        application_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-scholarship.html',
      })

    expect(res.status).toBe(201)
    const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(res.body.id)
    // The PIN: profile_id survives the column whitelist (it used to be
    // silently stripped, which made this whole branch unreachable).
    expect(row.profile_id).toBe('p-1')
    // The row is SCORED, not the unscored shape the migrations later stamped.
    expect(row.match_score).not.toBeNull()
    expect(Number.isFinite(Number(row.match_score))).toBe(true)
    expect(row.matcher_version).toBe('manual-create-scored')
    // The engine's own matched_needs, never the '["general funding support"]'
    // migration stamp.
    expect(row.matched_needs).not.toBe('["general funding support"]')
    expect(() => JSON.parse(row.matched_needs)).not.toThrow()
  })

  it('a caller-supplied score WINS — the route never overwrites it', async () => {
    const res = await request(appWith(db))
      .post('/api/grants')
      .send({
        title: 'Hand-scored source',
        organization_id: 'org-1',
        profile_id: 'p-1',
        match_score: 42,
      })

    expect(res.status).toBe(201)
    const row = db.prepare('SELECT match_score, matcher_version FROM grants WHERE id = ?').get(res.body.id)
    expect(row.match_score).toBe(42)
    expect(row.matcher_version).not.toBe('manual-create-scored')
  })

  it('refuses a profile that belongs to a DIFFERENT organization (G4/G8 — no cross-profile bleed at the write site)', async () => {
    const res = await request(appWith(db))
      .post('/api/grants')
      .send({
        title: 'Cross-org attempt',
        organization_id: 'org-1',
        profile_id: 'p-other-org',
      })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('profile_not_in_organization')
    expect(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n).toBe(0)
  })

  it('PUT never re-parents a grant across profiles — profile_id is create-time identity only', async () => {
    db.prepare(`INSERT INTO grants (id, organization_id, profile_id, title) VALUES ('g-1', 'org-1', 'p-1', 'Existing')`).run()

    const res = await request(appWith(db))
      .put('/api/grants/g-1')
      .send({ title: 'Renamed', profile_id: 'p-other-org' })

    expect(res.status).toBeLessThan(300)
    const row = db.prepare('SELECT title, profile_id FROM grants WHERE id = ?').get('g-1')
    expect(row.title).toBe('Renamed')
    expect(row.profile_id).toBe('p-1')
  })

  it('an ORGANIZATION-scoped create (no profile) stays unscored — nothing to score against', async () => {
    const res = await request(appWith(db))
      .post('/api/grants')
      .send({
        title: 'Org-level tracked grant',
        organization_id: 'org-1',
      })

    expect(res.status).toBe(201)
    const row = db.prepare('SELECT match_score, matcher_version FROM grants WHERE id = ?').get(res.body.id)
    expect(row.match_score).toBeNull()
    expect(row.matcher_version).not.toBe('manual-create-scored')
  })
})
