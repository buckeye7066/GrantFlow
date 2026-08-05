import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'

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
      match_explain_json TEXT,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      matcher_version TEXT,
      computed_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, created_at, updated_at)
    VALUES ('profile-focus-forward-ministries', 'church', 'church', 'OH', '43215', '["ministry","community"]', '["housing","transportation"]', '2026-04-26', '2026-04-26');
    INSERT INTO profiles (id, primary_type, applicant_type, state, zip, tags, interests, created_at, updated_at)
    VALUES
      ('profile-pa-business', 'business', 'business', NULL, NULL, '["business"]', '["equipment"]', '2026-04-26', '2026-04-26'),
      ('profile-no-state', 'individual', 'individual', NULL, NULL, '["housing"]', '["rent"]', '2026-04-26', '2026-04-26');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('profile-focus-forward-ministries', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"church"}');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES
      ('profile-pa-business', 'location_focus', '{"geographic_focus":"Beaver County, Pennsylvania"}'),
      ('profile-no-state', 'basic_information', '{"state":"USA","profile_category":"individual"}');
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
        'article-1', 'Benevolence Fund Basics', 'Church Law & Tax', 'crawler', 'article-1',
        'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html', 'verified_real',
        'Article about benevolence funds.',
        NULL, NULL, 'rolling', 'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html',
        1, 'nationwide', '["grant"]', '["church","benevolence"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'cap-43215', 'Find Your Local Community Action Agency', 'Community Action Partnership', 'crawler', 'cap-43215',
        'https://communityactionpartnership.com/find-a-cap/?zip=43215', 'verified_real',
        'Lookup local community action agency by ZIP.',
        NULL, NULL, 'rolling', 'https://communityactionpartnership.com/find-a-cap/?zip=43215',
        1, 'nationwide', '["benefit"]', '["community"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'cap-44101', 'Find Your Local Community Action Agency', 'Community Action Partnership', 'crawler', 'cap-44101',
        'https://communityactionpartnership.com/find-a-cap/?zip=44101', 'verified_real',
        'Lookup local community action agency by ZIP.',
        NULL, NULL, 'rolling', 'https://communityactionpartnership.com/find-a-cap/?zip=44101',
        1, 'nationwide', '["benefit"]', '["community"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'locator-oh', 'Foundation Locator', 'Council on Foundations', 'crawler', 'locator-oh',
        'https://example.org/foundation-locator?state=OH', 'verified_real',
        'Lookup foundations by state.',
        NULL, NULL, 'rolling', 'https://example.org/foundation-locator?state=OH',
        1, 'nationwide', '["directory"]', '["foundation"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'locator-mi', 'Foundation Locator', 'Council on Foundations', 'crawler', 'locator-mi',
        'https://example.org/foundation-locator?state=MI', 'verified_real',
        'Lookup foundations by state.',
        NULL, NULL, 'rolling', 'https://example.org/foundation-locator?state=MI',
        1, 'nationwide', '["directory"]', '["foundation"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'pa-grant-1', 'Pennsylvania Business Equipment Grant', 'PA Funder', 'grants.gov', 'pa-1',
        'https://www.grants.gov/search-results-detail/pa-1', 'verified_real',
        'Grant funding for Pennsylvania businesses buying equipment.',
        1000, 5000, 'rolling', 'https://www.grants.gov/search-results-detail/pa-1',
        0, 'PA', '["grant","business","equipment"]', '["business","equipment"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'fl-grant-1', 'Florida Business Equipment Grant', 'FL Funder', 'grants.gov', 'fl-1',
        'https://www.grants.gov/search-results-detail/fl-1', 'verified_real',
        'Grant funding for Florida businesses buying equipment.',
        1000, 5000, 'rolling', 'https://www.grants.gov/search-results-detail/fl-1',
        0, 'FL', '["grant","business","equipment"]', '["business","equipment"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      ),
      (
        'tn-grant-1', 'Tennessee Housing Grant', 'TN Funder', 'grants.gov', 'tn-1',
        'https://www.grants.gov/search-results-detail/tn-1', 'verified_real',
        'Grant funding for Tennessee residents.',
        1000, 5000, 'rolling', 'https://www.grants.gov/search-results-detail/tn-1',
        0, 'TN', '["grant","housing"]', '["housing","rent"]', 'grant', 'OPPORTUNITY', 1, 'grant'
      );
    INSERT INTO profile_opportunity_matches
      (profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version, computed_at, updated_at)
    VALUES
      ('profile-focus-forward-ministries', 'real-grant-1', 82, 'review', 'Crawler OS matched ministry/community signals.', '["profile_need_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-pa-business', 'real-grant-1', 62, 'review', 'Crawler OS matched a nationwide funding source.', '["nationwide_scope"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-pa-business', 'pa-grant-1', 86, 'accept', 'Crawler OS matched Pennsylvania business equipment signals.', '["profile_need_match","location_match"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('profile-no-state', 'real-grant-1', 58, 'review', 'Crawler OS matched only nationwide funding because profile state is unavailable.', '["nationwide_scope"]', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
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

describe('matching quality gate route', () => {
  it('excludes articles from matches and collapses query-template referral permutations', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-focus-forward-ministries/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1, allow_relax: 1 })

      expect(response.status).toBe(200)
      const urls = response.body.opportunities.map((opp) => opp.application_url || opp.url || '')
      expect(urls.some((url) => url.includes('churchlawandtax.com'))).toBe(false)
      expect(urls.some((url) => url.includes('find-a-cap/?zip='))).toBe(false)
      expect(urls.some((url) => url.includes('foundation-locator?state='))).toBe(false)
      expect(response.body.referrals).toHaveLength(0)
      expect(response.body.opportunities.length).toBeGreaterThan(0)
      expect(response.body.opportunities.every((opp) => Array.isArray(opp.match_reasons) && opp.match_reasons.length > 0)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns only matching-state and nationwide opportunities for a PA profile', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-pa-business/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1, allow_relax: 1 })

      expect(response.status).toBe(200)
      const states = response.body.opportunities.map((opp) => opp.state).filter(Boolean)
      expect(states.every((state) => state === 'PA' || state === 'nationwide')).toBe(true)
      expect(states).toContain('PA')
      expect(states).not.toContain('FL')
      expect(states).not.toContain('TN')
    } finally {
      db.close()
    }
  })

  it('does not return specific-state opportunities when profile state is missing or invalid', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-no-state/opportunities')
        .query({ min_score: 0, limit: 2000, skip_readiness_check: 1, allow_relax: 1 })

      expect(response.status).toBe(200)
      const states = response.body.opportunities.map((opp) => opp.state).filter(Boolean)
      expect(states.every((state) => state === 'nationwide')).toBe(true)
      expect(states).not.toContain('PA')
      expect(states).not.toContain('FL')
      expect(states).not.toContain('TN')
    } finally {
      db.close()
    }
  })
})
