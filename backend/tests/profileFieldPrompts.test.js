import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'
import { getProfileFieldPrompts } from '../services/profileFieldPrompts.js'

/**
 * Architecture P1: MISSING HIGH-VALUE FIELD PROMPTS.
 *
 * Asserts that GET /api/matching/profile/:id/opportunities returns a friendly
 * `profile_field_prompts` array — in BOTH the discovery_pending response (a
 * not-yet-discovered profile) and the normal response — and that the prompt
 * contents track the profile's actual gaps + type (missing state/type yields
 * the right prompts; a complete profile yields few/none).
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
      postal_code TEXT,
      keywords TEXT,
      interests TEXT,
      tags TEXT,
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
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      matcher_version TEXT,
      computed_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );

    -- Sparse profile: no type, no state/zip, no needs, no eligibility, never discovered.
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, last_discovery_at, created_at, updated_at)
    VALUES ('profile-sparse', NULL, NULL, NULL, NULL, NULL, '2026-06-01', '2026-06-01');

    -- A complete individual profile that HAS been discovered.
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, last_discovery_at, created_at, updated_at)
    VALUES ('profile-complete', 'individual', 'individual', 'OH', '43215', '2026-06-01 12:00:00', '2026-06-01', '2026-06-01');

    -- A nonprofit org with no EIN/501c3 (should get the org_status prompt).
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, last_discovery_at, created_at, updated_at)
    VALUES ('profile-nonprofit', 'nonprofit', 'nonprofit', 'OH', '43215', NULL, '2026-06-01', '2026-06-01');

    INSERT INTO profile_sections (profile_id, section_key, data) VALUES
      ('profile-complete', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"individual"}'),
      ('profile-complete', 'narrative', '{"primary_goal":"repair our family home roof after storm damage and stay housed"}'),
      ('profile-complete', 'demographics', '{"veteran_status":"veteran"}'),
      ('profile-complete', 'financial_information', '{"household_income":"35000","funding_amount_needed":"8000"}'),
      ('profile-nonprofit', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"nonprofit"}'),
      ('profile-nonprofit', 'narrative', '{"primary_goal":"youth after-school programs"}'),
      ('profile-nonprofit', 'demographics', '{"minority_owned":"yes"}'),
      ('profile-nonprofit', 'financial_information', '{"annual_revenue":"120000","funding_amount_needed":"50000"}');

    INSERT INTO funding_opportunities (
      id, title, sponsor, source, source_id, source_url, record_origin, description,
      amount_min, amount_max, deadline_type, application_url, is_national, state,
      categories, keywords, opportunity_type, type, is_active, source_category
    ) VALUES (
      'real-grant-1', 'Community Support Grant', 'Real Foundation', 'grants.gov', 'real-1',
      'https://www.grants.gov/search-results-detail/123', 'verified_real',
      'Grant funding for individuals and families in need.',
      1000, 5000, 'rolling', 'https://www.grants.gov/search-results-detail/123',
      1, 'nationwide', '["grant"]', '["housing","community"]', 'grant', 'OPPORTUNITY', 1, 'grant'
    );
    INSERT INTO profile_opportunity_matches
      (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version, computed_at, updated_at)
    VALUES
      ('profile-complete', 'real-grant-1', 76, 'review', 'Crawler OS matched housing/community signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
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

function expectValidPromptShape(prompts) {
  expect(Array.isArray(prompts)).toBe(true)
  for (const p of prompts) {
    expect(typeof p.field).toBe('string')
    expect(p.field.length).toBeGreaterThan(0)
    expect(typeof p.label).toBe('string')
    expect(p.label.length).toBeGreaterThan(0)
    expect(typeof p.why).toBe('string')
    expect(p.why.length).toBeGreaterThan(0)
    // section_key is a string or null (null = handled outside the section editor).
    expect(p.section_key === null || typeof p.section_key === 'string').toBe(true)
  }
}

describe('getProfileFieldPrompts (helper)', () => {
  it('returns the high-value prompts for a sparse profile (missing type + state)', async () => {
    const db = createDb()
    try {
      const prompts = await getProfileFieldPrompts(db, 'profile-sparse')
      expectValidPromptShape(prompts)
      const fields = prompts.map((p) => p.field)
      expect(fields).toContain('applicant_type')
      expect(fields).toContain('state_zip')
      expect(fields).toContain('primary_need')
      // The applicant_type prompt deep-links to basic_information.
      const typePrompt = prompts.find((p) => p.field === 'applicant_type')
      expect(typePrompt.section_key).toBe('basic_information')
    } finally {
      db.close()
    }
  })

  it('returns few/no prompts for a complete profile', async () => {
    const db = createDb()
    try {
      const prompts = await getProfileFieldPrompts(db, 'profile-complete')
      expectValidPromptShape(prompts)
      const fields = prompts.map((p) => p.field)
      // Core unlockers are all present, so none of these should be prompted.
      expect(fields).not.toContain('applicant_type')
      expect(fields).not.toContain('state_zip')
      expect(fields).not.toContain('primary_need')
      expect(fields).not.toContain('eligibility_traits')
      expect(fields).not.toContain('funding_amount')
      expect(prompts.length).toBeLessThanOrEqual(1)
    } finally {
      db.close()
    }
  })

  it('prompts an org profile for its EIN / 501(c)(3) / org type', async () => {
    const db = createDb()
    try {
      const prompts = await getProfileFieldPrompts(db, 'profile-nonprofit')
      const fields = prompts.map((p) => p.field)
      expect(fields).toContain('org_status')
      // Org has location, needs, demographics, budget — so ONLY org_status remains.
      expect(fields).not.toContain('state_zip')
      expect(fields).not.toContain('primary_need')
    } finally {
      db.close()
    }
  })

  it('never throws — returns [] for a missing db/profile', async () => {
    expect(await getProfileFieldPrompts(null, 'x')).toEqual([])
    const db = createDb()
    try {
      expect(await getProfileFieldPrompts(db, 'does-not-exist')).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('matching /opportunities includes profile_field_prompts', () => {
  it('includes prompts in the discovery_pending response', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-sparse/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBe(true)
      expectValidPromptShape(response.body.profile_field_prompts)
      const fields = response.body.profile_field_prompts.map((p) => p.field)
      expect(fields).toContain('applicant_type')
      expect(fields).toContain('state_zip')
    } finally {
      db.close()
    }
  })

  it('includes prompts in the normal (discovered) response', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-complete/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1 })

      expect(response.status).toBe(200)
      expect(response.body.discovery_pending).toBeFalsy()
      // Field present + correctly shaped (few/none for a complete profile).
      expectValidPromptShape(response.body.profile_field_prompts)
      expect(response.body.profile_field_prompts.length).toBeLessThanOrEqual(1)
      // Additive: existing fields are untouched.
      expect(Array.isArray(response.body.score_histogram)).toBe(true)
      expect(Array.isArray(response.body.opportunities)).toBe(true)
    } finally {
      db.close()
    }
  })
})
