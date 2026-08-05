import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'
import { stampLastDiscoveryAt } from '../services/autoDiscoveryCrawlers.js'
import { MIN_SCORE_SLIDER_MAX } from '../config/matchThresholds.js'

/**
 * Feature A (discovery-pending gate) + Feature B (score_histogram) tests for
 * GET /api/matching/profile/:profileId/opportunities.
 *
 * The schema mirrors matchingQualityGateRoute.test.js but ADDS the
 * profiles.last_discovery_at column (the per-profile "discovery has run"
 * signal). When it is NULL the endpoint must return discovery_pending:true +
 * an empty list WITHOUT querying the catalog; once stamped it behaves normally
 * and includes a score_histogram.
 */
function createDb() {
  const db = new Database(':memory:')
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
      type TEXT DEFAULT 'OPPORTUNITY',
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      profile_id TEXT,
      source_category TEXT,
      link_status TEXT DEFAULT 'unknown'
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
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_confidence REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      matcher_version TEXT,
      computed_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );
    -- Profile with NO discovery run yet (last_discovery_at IS NULL).
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('profile-never-discovered', 'church', 'church', 'OH', '43215', '["ministry","community"]', '["housing"]', NULL, '2026-04-26', '2026-04-26');
    -- Same kind of profile, but discovery HAS run (stamped).
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, last_discovery_at, created_at, updated_at)
    VALUES ('profile-discovered', 'church', 'church', 'OH', '43215', '["ministry","community"]', '["housing"]', '2026-04-26 12:00:00', '2026-04-26', '2026-04-26');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES
      ('profile-never-discovered', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"church"}'),
      ('profile-discovered', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"church"}');
    INSERT INTO funding_opportunities (
      id, title, sponsor, source, source_id, source_url, record_origin, description,
      amount_min, amount_max, deadline_type, application_url, is_national, state,
      categories, keywords, opportunity_type, type, is_active, source_category
    ) VALUES
      (
        'real-grant-1', 'Community Ministry Grant', 'Real Foundation', 'grants.gov', 'real-1',
        'https://www.grants.gov/search-results-detail/123', 'verified_real',
        'Grant funding for churches and ministries serving community needs.',
        1000, 5000, 'rolling', 'https://www.grants.gov/search-results-detail/123',
        1, 'nationwide', '["grant","ministry"]', '["ministry","community","housing"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'real-grant-2', 'Faith Community Housing Fund', 'HUD', 'grants.gov', 'real-2',
        'https://www.grants.gov/search-results-detail/456', 'verified_real',
        'Housing support for faith communities and ministries.',
        2000, 8000, 'rolling', 'https://www.grants.gov/search-results-detail/456',
        1, 'nationwide', '["grant","housing"]', '["ministry","community","housing"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      );
    INSERT INTO profile_opportunity_matches
      (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version, computed_at, updated_at)
    VALUES
      ('profile-never-discovered', 'real-grant-1', 78, 'review', 'Crawler OS matched ministry/community signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-never-discovered', 'real-grant-2', 74, 'review', 'Crawler OS matched housing ministry signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-discovered', 'real-grant-1', 78, 'review', 'Crawler OS matched ministry/community signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-discovered', 'real-grant-2', 74, 'review', 'Crawler OS matched housing ministry signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `)
  return db
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

describe('matching discovery-pending gate (Feature A)', () => {
  it('returns discovery_pending + empty list when last_discovery_at is NULL', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-never-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBe(true)
      expect(Array.isArray(response.body.opportunities)).toBe(true)
      expect(response.body.opportunities).toHaveLength(0)
      expect(typeof response.body.message).toBe('string')
      expect(response.body.message.toLowerCase()).toContain('discovery')
    } finally {
      db.close()
    }
  })

  it('returns normal results (not discovery_pending) once last_discovery_at is set', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBeFalsy()
      expect(Array.isArray(response.body.opportunities)).toBe(true)
      expect(response.body.opportunities.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('bypasses the gate with ?ignore_discovery_gate=1 even when NULL', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-never-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1, ignore_discovery_gate: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBeFalsy()
      expect(Array.isArray(response.body.opportunities)).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('stampLastDiscoveryAt (Feature A stamping)', () => {
  it('stamps last_discovery_at and flips the gate from pending to normal', async () => {
    const db = createDb()
    try {
      // Initially pending.
      const before = await request(createApp(db))
        .get('/api/matching/profile/profile-never-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })
      expect(before.body.discovery_pending).toBe(true)

      // Stamp it (as triggerAutoDiscoveryCrawlers / the realCrawlers POST
      // handlers do after enqueuing/running discovery).
      const ok = await stampLastDiscoveryAt(db, 'profile-never-discovered')
      expect(ok).toBe(true)

      const row = db.prepare('SELECT last_discovery_at FROM profiles WHERE id = ?').get('profile-never-discovered')
      expect(row.last_discovery_at).toBeTruthy()

      // Now it behaves normally — no longer discovery_pending.
      const after = await request(createApp(db))
        .get('/api/matching/profile/profile-never-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })
      expect(after.body.discovery_pending).toBeFalsy()
      expect(after.body.opportunities.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('is tolerant: returns false (never throws) for a missing db/profile', async () => {
    expect(await stampLastDiscoveryAt(null, 'x')).toBe(false)
    const db = createDb()
    try {
      expect(await stampLastDiscoveryAt(db, '')).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('matching score_histogram (Feature B)', () => {
  it('includes a well-formed score_histogram on a normal (discovered) response', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      const hist = response.body.score_histogram
      expect(Array.isArray(hist)).toBe(true)
      expect(hist.length).toBeGreaterThan(0)
      // Buckets span the display bands contiguously up to the slider max
      // (data-point scale; edges = the canonical Broad/Good/Strong/Best bands).
      expect(hist[0].min).toBe(0)
      expect(hist[hist.length - 1].max).toBe(MIN_SCORE_SLIDER_MAX)
      let totalCount = 0
      for (const bucket of hist) {
        expect(typeof bucket.min).toBe('number')
        expect(typeof bucket.max).toBe('number')
        expect(bucket.max).toBeGreaterThan(bucket.min)
        expect(typeof bucket.count).toBe('number')
        expect(bucket.count).toBeGreaterThanOrEqual(0)
        // top_source is either null or a friendly (non-jargon) string.
        expect(bucket.top_source === null || typeof bucket.top_source === 'string').toBe(true)
        totalCount += bucket.count
      }
      // Every scored opportunity lands in exactly one bucket.
      expect(totalCount).toBeGreaterThan(0)
      // At least one bucket attributes results to a friendly federal label
      // (both seed grants are grants.gov → "Federal grants").
      const families = hist.map((b) => b.top_source).filter(Boolean)
      expect(families.some((f) => /federal/i.test(f))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns an empty score_histogram array in the discovery_pending response', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-never-discovered/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBe(true)
      expect(Array.isArray(response.body.score_histogram)).toBe(true)
      expect(response.body.score_histogram).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
