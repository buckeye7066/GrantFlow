import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'

import schoolPortalRouter, { generateApiKey, hashApiKey } from '../routes/schoolPortal.js'

/**
 * Integration tests for /api/school-portal/*.
 *
 * Builds a tiny in-memory SQLite database with the canonical tables the
 * production schema declares (profiles, profile_sections, users,
 * funding_opportunities, plus the new school-portal trio) so we exercise
 * the merger, matcher integration, and bearer-token auth in one shot.
 */

function createApp(db) {
  const app = express()
  app.use(express.json())
  // Same dialect contract every router relies on.
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/school-portal', schoolPortalRouter)
  return app
}

function seedSchema(db) {
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      user_id TEXT,
      primary_type TEXT,
      display_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]'
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      display_name TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      funder_name TEXT,
      url TEXT,
      amount_min REAL,
      amount_max REAL,
      status TEXT DEFAULT 'active',
      categories TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      eligibility TEXT DEFAULT '{}'
    );
    CREATE TABLE school_partners (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ein TEXT,
      ipeds_id TEXT,
      contact_name TEXT,
      contact_email TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      allowed_origins TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE school_partner_api_keys (
      id TEXT PRIMARY KEY,
      school_partner_id TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT,
      created_by TEXT,
      last_used_at DATETIME,
      expires_at DATETIME,
      revoked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE school_student_links (
      id TEXT PRIMARY KEY,
      school_partner_id TEXT NOT NULL,
      profile_id TEXT,
      external_student_id TEXT NOT NULL,
      email TEXT,
      consent_status TEXT NOT NULL DEFAULT 'granted',
      consented_at DATETIME,
      revoked_at DATETIME,
      last_synced_at DATETIME,
      last_sync_payload_hash TEXT,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(school_partner_id, external_student_id)
    );
  `)
}

function seedSampleOpps(db) {
  // Three real-world-shape opportunities; the matcher should at minimum
  // surface these for any active student profile.
  const stmt = db.prepare(`INSERT INTO funding_opportunities
    (id, title, funder_name, url, amount_max, status, categories, tags, keywords)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
  stmt.run('opp1', 'Federal Pell Grant', 'US Department of Education',
    'https://studentaid.gov/pell', 7395,
    JSON.stringify(['student_aid', 'scholarship']),
    JSON.stringify(['student', 'pell', 'undergraduate']),
    JSON.stringify(['scholarship', 'tuition', 'pell', 'fafsa']))
  stmt.run('opp2', 'TN HOPE Scholarship', 'Tennessee Education Lottery',
    'https://www.tn.gov/collegepays/money-for-college/state-of-tennessee-programs/hope-scholarship.html',
    8000,
    JSON.stringify(['student_aid', 'scholarship']),
    JSON.stringify(['student', 'tn']),
    JSON.stringify(['scholarship', 'tuition', 'tennessee', 'hope']))
  stmt.run('opp3', 'University of Memphis Need-Based Grant', 'University of Memphis',
    'https://www.memphis.edu/financialaid/', 5000,
    JSON.stringify(['student_aid', 'scholarship']),
    JSON.stringify(['student', 'memphis']),
    JSON.stringify(['institutional', 'aid', 'need-based']))
}

// Wrap better-sqlite3 prepare to mirror our production normalizer (booleans
// → 0/1, dates → ISO strings, objects → JSON) so the route's `.run(...)`
// arguments don't blow up.
function wrapDb(rawDb) {
  function normalize(value) {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      try { return JSON.stringify(value) } catch { return String(value) }
    }
    return value
  }
  function normalizeArgs(args) { return args.map(normalize) }
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = rawDb.prepare(sql)
      return {
        get: (...args) => stmt.get(...normalizeArgs(args)),
        all: (...args) => stmt.all(...normalizeArgs(args)),
        run: (...args) => stmt.run(...normalizeArgs(args)),
      }
    },
    raw: rawDb,
  }
}

function insertPartnerWithKey(db, { slug, name }) {
  const partnerId = crypto.randomUUID()
  db.prepare(`INSERT INTO school_partners (id, slug, name, status, allowed_origins, metadata)
              VALUES (?, ?, ?, 'active', '[]', '{}')`).run(partnerId, slug, name)
  const key = generateApiKey()
  const keyId = crypto.randomUUID()
  db.prepare(`INSERT INTO school_partner_api_keys (id, school_partner_id, key_hash, key_prefix, label)
              VALUES (?, ?, ?, ?, 'test-key')`)
    .run(keyId, partnerId, key.hash, key.prefix)
  return { partnerId, keyId, rawKey: key.raw }
}

describe('/api/school-portal', () => {
  let rawDb
  let db
  let app

  beforeEach(() => {
    rawDb = new Database(':memory:')
    seedSchema(rawDb)
    seedSampleOpps(rawDb)
    db = wrapDb(rawDb)
    app = createApp(db)
  })

  it('rejects requests without a Bearer API key', async () => {
    const res = await request(app).get('/api/school-portal/me')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('MISSING_API_KEY')
  })

  it('rejects requests with an unknown API key', async () => {
    const res = await request(app)
      .get('/api/school-portal/me')
      .set('Authorization', 'Bearer not-a-real-key')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_API_KEY')
  })

  it('GET /me returns the partner identity', async () => {
    const { rawKey, partnerId } = insertPartnerWithKey(rawDb, { slug: 'memphis', name: 'University of Memphis' })
    const res = await request(app)
      .get('/api/school-portal/me')
      .set('Authorization', `Bearer ${rawKey}`)
    expect(res.status).toBe(200)
    expect(res.body.partner.id).toBe(partnerId)
    expect(res.body.partner.slug).toBe('memphis')
    expect(res.body.student_link_count).toBe(0)
  })

  it('POST /students/sync creates profiles, GET /matches returns scored opps', async () => {
    const { rawKey } = insertPartnerWithKey(rawDb, { slug: 'memphis', name: 'University of Memphis' })

    const sync = await request(app)
      .post('/api/school-portal/students/sync')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({
        students: [{
          external_student_id: 'U001',
          school_email: 'jane.doe@memphis.edu',
          full_name: 'Jane Doe',
          student_level: 'Undergraduate',
          primary_major: 'Nursing',
          cumulative_gpa: '3.42',
          home_state: 'TN',
          zip_code: '38103',
          is_pell_eligible: true,
        }],
      })
    expect(sync.status).toBe(200)
    expect(sync.body.ok).toBe(true)
    expect(sync.body.succeeded).toBe(1)
    const created = sync.body.results[0]
    expect(created.action).toBe('created')
    expect(created.external_student_id).toBe('U001')

    const matches = await request(app)
      .get('/api/school-portal/students/U001/matches?limit=5')
      .set('Authorization', `Bearer ${rawKey}`)
    expect(matches.status).toBe(200)
    expect(matches.body.ok).toBe(true)
    expect(matches.body.included).toBeGreaterThan(0)
    expect(matches.body.matches[0]).toHaveProperty('title')
    expect(matches.body.matches[0]).toHaveProperty('score')
  })

  it('GET /students/:id returns the merged profile snapshot', async () => {
    const { rawKey } = insertPartnerWithKey(rawDb, { slug: 'memphis', name: 'University of Memphis' })
    await request(app)
      .post('/api/school-portal/students/sync')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({
        external_student_id: 'U002',
        school_email: 'bob@memphis.edu',
        full_name: 'Bob Smith',
        student_level: 'Undergraduate',
      })

    const snap = await request(app)
      .get('/api/school-portal/students/U002')
      .set('Authorization', `Bearer ${rawKey}`)
    expect(snap.status).toBe(200)
    expect(snap.body.profile.display_name).toBe('Bob Smith')
    expect(snap.body.profile.primary_type).toBe('college_student')
    expect(snap.body.profile.sections.basic_information.email).toBe('bob@memphis.edu')
    expect(snap.body.link.consent_status).toBe('granted')
  })

  it('POST /students/:id/revoke revokes the link and blocks /matches', async () => {
    const { rawKey } = insertPartnerWithKey(rawDb, { slug: 'memphis', name: 'University of Memphis' })
    await request(app)
      .post('/api/school-portal/students/sync')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({
        external_student_id: 'U003',
        full_name: 'Ravi Singh',
        student_level: 'Undergraduate',
      })

    const revoke = await request(app)
      .post('/api/school-portal/students/U003/revoke')
      .set('Authorization', `Bearer ${rawKey}`)
    expect(revoke.status).toBe(200)
    expect(revoke.body.revoked).toBe(true)

    const matches = await request(app)
      .get('/api/school-portal/students/U003/matches')
      .set('Authorization', `Bearer ${rawKey}`)
    expect(matches.status).toBe(403)
    expect(matches.body.code).toBe('CONSENT_REVOKED')
  })

  it('rejects sync records missing external_student_id', async () => {
    const { rawKey } = insertPartnerWithKey(rawDb, { slug: 'memphis', name: 'University of Memphis' })
    const res = await request(app)
      .post('/api/school-portal/students/sync')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({ students: [{ full_name: 'Nameless', email: 'n@m.edu' }] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.failed).toBe(1)
    expect(res.body.failures[0].code).toBe('MISSING_EXTERNAL_ID')
  })

  it('blocks admin endpoints when req.user is not admin', async () => {
    const res = await request(app)
      .post('/api/school-portal/admin/partners')
      .send({ slug: 'x', name: 'X' })
    expect(res.status).toBe(403)
  })
})
