import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'

/**
 * Crawler OS matching authority regression.
 *
 * Sparse OS coverage must stay honest. The old route used to fall through to a
 * broad catalog matcher and merge generic results when OS coverage was sparse;
 * that made different profiles see the same unrelated funding. The invariant
 * now is simple: profile_opportunity_matches from Crawler OS are the answer.
 */

function createSchema(db) {
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      primary_type TEXT,
      applicant_type TEXT,
      state TEXT,
      zip TEXT,
      tags TEXT,
      interests TEXT,
      last_discovery_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      opportunity_type TEXT,
      opportunity_kind TEXT,
      type TEXT DEFAULT 'OPPORTUNITY',
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      profile_id TEXT,
      source_category TEXT,
      fingerprint TEXT,
      link_status TEXT DEFAULT 'unknown'
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT,
      opportunity_id TEXT,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      matcher_version TEXT
    );
  `)
}

function seedStudent(db) {
  db.exec(`
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('student-1', 'individual', 'individual', 'TN', '37130', '["student"]', '["scholarship","tuition"]', '2026-06-23 12:00:00', '2026-06-23', '2026-06-23');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('student-1', 'basic_information', '{"state":"TN","zip_code":"37130","profile_category":"individual"}');
  `)

  const dirs = [
    ['os-dir-benefits', 'Benefits.gov finder - education benefits', 'benefits_gov', 'DIRECTORY', 68],
    ['os-dir-cof', 'Foundation Center locator', 'cof_locator', 'DIRECTORY', 55],
    ['os-dir-studentaid', 'StudentAid.gov aid types', 'studentaid_gov', 'DIRECTORY', 60],
  ]
  for (const [id, title, source, kind, score] of dirs) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, is_active, categories, keywords)
       VALUES (?, ?, 'Gov', ?, ?, 'https://example.gov/', 'https://example.gov/', ?, 'DIRECTORY', 'directory', 1, 1, '["directory"]', '["scholarship","education"]')`,
    ).run(id, title, source, id, kind)
    db.prepare(
      `INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version)
       VALUES ('student-1', ?, ?, 'REVIEW', 'Directory pointer', '[]', 'crawler-os')`,
    ).run(id, score)
  }

  for (let i = 1; i <= 6; i += 1) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, is_active, categories, keywords, amount_max)
       VALUES (?, ?, 'Scholarship Fund', 'grants.gov', ?, 'https://www.grants.gov/x', 'https://www.grants.gov/x', 'SCHOLARSHIP', 'OPPORTUNITY', 'scholarship', 1, 1, '["scholarship"]', '["scholarship","tuition","student","education"]', 5000)`,
    ).run(`real-sch-${i}`, `Catalog Scholarship ${i}`, `real-sch-${i}`)
  }
}

function seedRichOs(db) {
  db.exec(`
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('org-1', 'organization', 'organization', 'TN', '37130', '["nonprofit"]', '["community"]', '2026-06-23 12:00:00', '2026-06-23', '2026-06-23');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('org-1', 'basic_information', '{"state":"TN","profile_category":"organization"}');
  `)
  for (let i = 1; i <= 12; i += 1) {
    const id = `os-rich-${i}`
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, is_active, categories, keywords, amount_max)
       VALUES (?, ?, 'Foundation', 'grants.gov', ?, 'https://www.grants.gov/y', 'https://www.grants.gov/y', 'DIRECT_GRANT', 'OPPORTUNITY', 'grant', 1, 1, '["grant"]', '["community","nonprofit"]', 25000)`,
    ).run(id, `Rich OS Grant ${i}`, id)
    db.prepare(
      `INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version)
       VALUES ('org-1', ?, ?, 'ACCEPT', 'Strong', '[]', 'crawler-os')`,
    ).run(id, 75 + i)
  }
}

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.ctx = { userId: 'admin-1', isAdmin: true }
    req.db = db
    next()
  })
  app.use('/api/matching', matchingRouter)
  return app
}

describe('matching Crawler OS authority', () => {
  it('returns sparse OS rows without merging catalog-only grants', async () => {
    const db = new Database(':memory:')
    createSchema(db)
    seedStudent(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/student-1/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(res.status).toBe(200)
      expect(res.body.engine).toBe('crawler-os')
      const opps = res.body.opportunities
      expect(Array.isArray(opps)).toBe(true)

      const catalogOnlyCount = opps.filter((o) => String(o.id).startsWith('real-sch-')).length
      expect(catalogOnlyCount).toBe(0)

      const dirIds = opps.map((o) => o.id).filter((id) => String(id).startsWith('os-dir-'))
      expect(dirIds.length).toBe(3)
      expect(res.body.os_merged_count).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('returns rich OS matches from the same OS-only path', async () => {
    const db = new Database(':memory:')
    createSchema(db)
    seedRichOs(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/org-1/opportunities')
        .query({ min_score: 50, limit: 2000, skip_readiness_check: 1 })

      expect(res.status).toBe(200)
      expect(res.body.engine).toBe('crawler-os')
      expect(res.body.opportunities.length).toBeGreaterThanOrEqual(10)
      expect(res.body.os_merged_count).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('rejects explicit legacy matching requests', async () => {
    const db = new Database(':memory:')
    createSchema(db)
    seedStudent(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/student-1/opportunities')
        .query({ legacy_matching: 1, skip_readiness_check: 1 })

      expect(res.status).toBe(410)
      expect(res.body.error).toBe('legacy_matching_retired')
      expect(res.body.engine).toBe('crawler-os')
    } finally {
      db.close()
    }
  })
})
