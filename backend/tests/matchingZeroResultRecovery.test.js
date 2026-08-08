import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Mission regression: "0 included of X found" must never happen.
 *
 * The Discover read path (GET /api/matching/profile/:id/opportunities) used to
 * apply a hard score floor (DEFAULT_MIN_SCORE = 75) and return `returned: 0`
 * whenever every Crawler-OS candidate scored below it — even though real
 * candidates existed (total_candidates > 0). That is the documented
 * "0 included of X found" failure.
 *
 * These tests prove the zero-result recovery ladder now surfaces multiple
 * funding sources (honestly flagged as relaxed) instead of returning empty,
 * and that strict behavior is reachable through every documented disable alias.
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
      match_confidence REAL,
      match_explain_json TEXT,
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

/**
 * Seed a profile whose Crawler-OS matches are ALL below the default 75 floor
 * (scores 50–66). Pre-fix, this returned `returned: 0`. Post-fix, the recovery
 * ladder must surface them.
 */
function seedBelowFloor(db) {
  db.exec(`
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('below-floor', 'individual', 'individual', 'OH', '43215', '["housing"]', '["rent","utilities"]', '2026-06-23 12:00:00', '2026-06-23', '2026-06-23');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('below-floor', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"individual"}');
  `)
  const opps = [
    ['below-1', 'Ohio Emergency Rent Assistance', 'housing', 66],
    ['below-2', 'Franklin County Utility Help', 'utilities', 58],
    ['below-3', 'Community Eviction Prevention Fund', 'housing', 52],
    ['below-4', 'Local Food & Rent Bridge Program', 'housing', 50],
  ]
  for (const [id, title, cat, score] of opps) {
    db.prepare(
      `INSERT INTO funding_opportunities
        (id, title, sponsor, source, source_id, source_url, application_url, opportunity_kind, type, opportunity_type, is_national, state, is_active, categories, keywords, eligibility_bullets, amount_max, record_origin)
       VALUES (?, ?, 'State Fund', 'grants.gov', ?, 'https://www.grants.gov/x', 'https://www.grants.gov/x', 'DIRECT_GRANT', 'OPPORTUNITY', 'grant', 0, 'OH', 1, ?, '["rent","utility assistance","eviction"]', '["Eligible applicants include Ohio residents needing rent help"]', 5000, 'verified_real')`,
    ).run(id, title, id, JSON.stringify([cat]))
    db.prepare(
      `INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version)
       VALUES ('below-floor', ?, ?, 'REVIEW', 'Below-floor housing match', '["profile_need_match"]', 'crawler-os')`,
    ).run(id, score)
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

describe('matching zero-result recovery (no "0 included of X found")', () => {
  // Matching router cold-import is heavy (profile helpers + pipeline + email).
  // Keep assertions tight; give the request path room so CI/local do not flake
  // on import cost after the recovery ladder already logged a successful resurface.
  it('surfaces multiple sources via the recovery ladder when all candidates are below the floor', { timeout: 60000 }, async () => {
    const db = new Database(':memory:')
    createSchema(db)
    seedBelowFloor(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/below-floor/opportunities')
        // Slider set above the 0–100 score scale — real candidates exist but
        // none can clear the floor (the "0 included of X found" condition).
        .query({ min_score: 101, limit: 2000, skip_readiness_check: 1 })

      expect(res.status).toBe(200)
      expect(res.body.engine).toBe('crawler-os')

      // Mission rule: candidates exist → results must be returned, not 0.
      expect(res.body.coverage_summary.total_candidates).toBeGreaterThan(0)
      expect(res.body.returned).toBeGreaterThan(1)
      expect(res.body.opportunities.length).toBeGreaterThan(1)

      // Counts map 1:1: returned can never exceed the scored pool.
      expect(res.body.returned).toBeLessThanOrEqual(res.body.total_scored)
      // Discover Grants contract aliases (included / total_found).
      expect(res.body.included).toBe(res.body.returned)
      expect(res.body.included).toBe(res.body.opportunities.length)
      expect(res.body.total_found).toBeGreaterThanOrEqual(res.body.included)
      expect(res.body.coverage_summary.included).toBe(res.body.included)

      // The recovery is surfaced honestly, not silent.
      expect(res.body.relaxation).toBeTruthy()
      expect(res.body.relaxation.applied).toBe(true)
    } finally {
      db.close()
    }
  })

  it('HARD INELIGIBILITY IS NEVER OUTRUNNABLE: recovery never returns a REJECT/ineligible/relaxed row', { timeout: 60000 }, async () => {
    // The 2026-07-28 audit found Tier B re-canonicalized raw candidates with
    // rejectHardIneligible:false and RELABELED live-decision REJECT rows to
    // match_decision:'REVIEW' + eligibility_relaxed:true — a path that, for any
    // REJECT row surviving canonicalization's other gates, would put a
    // hard-ineligible source in the owner's opportunities array. Canonical
    // rule (canonical_rules.md): hard ineligibility stays REJECT no matter how
    // empty the result set is. The relabel is removed and a final surfacing
    // guard now filters REJECT/ineligible/relaxed rows regardless of how they
    // arrived. This asserts the END-TO-END invariant over the below-floor
    // recovery set (which really does surface relaxed-SCORE rows): none of the
    // surfaced rows is a REJECT, ineligible, or eligibility-RELAXED row.
    const db = new Database(':memory:')
    createSchema(db)
    seedBelowFloor(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/below-floor/opportunities')
        .query({ min_score: 101, limit: 2000, skip_readiness_check: 1 })

      expect(res.status).toBe(200)
      expect(res.body.returned).toBeGreaterThan(0) // recovery DID surface eligible rows
      for (const o of res.body.opportunities ?? []) {
        expect(String(o.match_decision ?? o.decision ?? '').toUpperCase()).not.toBe('REJECT')
        expect(o.eligible).not.toBe(false)
        // eligibility (not score) was never relaxed — the removed relabel is
        // the only thing that ever set this flag.
        expect(o.eligibility_relaxed).not.toBe(true)
      }
      expect(res.body.relaxation?.eligibility_relaxed).not.toBe(true)
    } finally {
      db.close()
    }
  })

  it('static tripwire: the Tier B REJECT→REVIEW relabel is gone and never returns', () => {
    // A crafted live seed can't reliably reach the relabel (trust/profile
    // gates drop the common hard-ineligible classes first), so guard the
    // removal structurally: the route must not relabel a REJECT to REVIEW, and
    // must not mint eligibility_relaxed on recovered rows.
    const src = readFileSync(join(__dirname, '..', 'routes', 'matching.js'), 'utf8')
    expect(src).not.toMatch(/match_decision:\s*['"]REVIEW['"]/)
    expect(src).not.toMatch(/eligibility_relaxed:\s*true/)
    // The defense-in-depth final surfacing filter must be present.
    expect(src).toMatch(/\.toUpperCase\(\)\s*!==\s*['"]REJECT['"]/)
  })

  it.each([
    ['no_fallback=1', { no_fallback: 1 }],
    ['strict=1', { strict: 1 }],
    ['allow_relax=0', { allow_relax: 0 }],
  ])('%s preserves strict behavior (returns 0 below the floor)', { timeout: 60000 }, async (_label, strictQuery) => {
    const db = new Database(':memory:')
    createSchema(db)
    seedBelowFloor(db)
    try {
      const res = await request(createApp(db))
        .get('/api/matching/profile/below-floor/opportunities')
        .query({ min_score: 101, limit: 2000, skip_readiness_check: 1, ...strictQuery })

      expect(res.status).toBe(200)
      expect(res.body.returned).toBe(0)
      expect(res.body.relaxation).toBeUndefined()
      // The candidate pool is still reported so suppression is observable.
      expect(res.body.coverage_summary.total_candidates).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
