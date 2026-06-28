import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'

/**
 * OS recall-floor merge regression.
 *
 * Live audit (2026-06-23): Anastasia's profile had exactly 3 crawler-os
 * matches — all DIRECTORY pointers (benefits.gov, cof_locator,
 * studentaid.gov) — while the catalog held 90k+ real rows. Because the
 * matching route returned the OS rows verbatim whenever osRows.length > 0,
 * Discover showed only those 3 directories and hid every real grant. That
 * violates the mission rules: "Avoid zero-result experiences when relevant
 * funding likely exists. Recall over suppression" and the 1:1 count rule.
 *
 * The fix: when OS qualified.length < OS_RECALL_FLOOR, fall through to the
 * legacy matcher (full catalog scan) and merge the OS rows (qualified +
 * directories) on top. These tests prove:
 *   1. A sparse, directory-only OS run still surfaces real legacy grants.
 *   2. The OS directory rows are preserved (not dropped) in the merge.
 *   3. A rich OS run (>= floor) still short-circuits to the pure OS path.
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
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      fingerprint TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT
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

  // Three DIRECTORY pointers — the only OS-stored matches (mirrors the live
  // Anastasia bug). Scores are intentionally REVIEW-band.
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

  // Real scholarships in the catalog that the legacy matcher SHOULD surface.
  for (let i = 1; i <= 6; i += 1) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, is_active, categories, keywords, amount_max)
       VALUES (?, ?, 'Scholarship Fund', 'grants.gov', ?, 'https://www.grants.gov/x', 'https://www.grants.gov/x', 'SCHOLARSHIP', 'OPPORTUNITY', 'scholarship', 1, 1, '["scholarship"]', '["scholarship","tuition","student","education"]', 5000)`,
    ).run(`real-sch-${i}`, `Real Scholarship ${i}`, `real-sch-${i}`)
  }
}

function seedRichOs(db) {
  db.exec(`
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('org-1', 'nonprofit', 'nonprofit', 'TN', '37130', '["nonprofit","community programs"]', '["capacity building","program funding"]', '2026-06-23 12:00:00', '2026-06-23', '2026-06-23');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('org-1', 'basic_information', '{"state":"TN","profile_category":"nonprofit"}');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('org-1', 'narrative', '{"mission":"Community nonprofit seeking capacity building and program funding."}');
  `)
  // 12 real OS-qualified matches — above the recall floor (10).
  for (let i = 1; i <= 12; i += 1) {
    const id = `os-rich-${i}`
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, is_active, categories, keywords, eligibility_bullets, amount_max)
       VALUES (?, ?, 'Foundation', 'grants.gov', ?, 'https://www.grants.gov/y', 'https://www.grants.gov/y', 'DIRECT_GRANT', 'OPPORTUNITY', 'grant', 1, 1, '["nonprofit_ministry","capacity_building","programs"]', '["community","nonprofit","capacity building","program funding"]', '["Eligible applicants include nonprofit organizations"]', 25000)`,
    ).run(id, `Nonprofit Community Program Grant ${i}`, id)
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

describe('matching OS recall-floor merge', () => {
  it('merges real legacy grants when OS only has directory pointers (sparse recall)', async () => {
    const db = new Database(':memory:')
    createSchema(db)
    seedStudent(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/student-1/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(res.status).toBe(200)
      const opps = res.body.opportunities
      expect(Array.isArray(opps)).toBe(true)

      // Real scholarships must now appear (the whole point of the fix).
      const realCount = opps.filter((o) => String(o.id).startsWith('real-sch-')).length
      expect(realCount).toBeGreaterThan(0)

      // The OS directory pointers must be PRESERVED, not dropped.
      const dirIds = opps.map((o) => o.id).filter((id) => String(id).startsWith('os-dir-'))
      expect(dirIds.length).toBeGreaterThan(0)

      // Engine flag reflects the merge so the UI/telemetry can explain it.
      expect(res.body.engine).toBe('crawler-os+legacy')
      expect(res.body.os_merged_count).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('short-circuits to the pure OS path when OS recall is rich (>= floor)', async () => {
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
      // Pure OS path does not set os_merged_count.
      expect(res.body.os_merged_count).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
