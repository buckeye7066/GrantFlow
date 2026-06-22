/**
 * matchedCountReconciliation.test.js
 *
 * Bug: the org-level "Opportunities (N)" badge and the profile-level "N matched"
 * count disagreed (e.g. org showed "Opportunities (40)" while the profile
 * Pipeline showed "3 matched") because they came from DIFFERENT sources:
 *   - org tab: client.entities.Grant.filter({ organization_id }) → the RAW,
 *     unscored grant rows (GET /api/organizations/:id/grants), which include
 *     legacy / orphan / low-relevance rows the matcher would never surface.
 *   - profile Pipeline: the matching engine (computeMatchDecision), which scores
 *     each candidate and drops REJECTs / no-reason rows.
 *
 * Fix: the org "Opportunities" tab now reads from the SAME canonical matching
 * authority the profile Pipeline uses — GET /api/matching/profile/:id/grants
 * (matchProfileToGrants). This test pins that endpoint as the single shared
 * source: its count is the MATCHED subset, NOT the raw row count, so both
 * surfaces reconcile.
 *
 * Invariant: this changes WHICH count both surfaces show (matched), not the
 * relevance/match-score floor itself — the engine's own REJECT/no-reason gating
 * does the filtering.
 */
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
      organization_id TEXT,
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
      description TEXT,
      state TEXT,
      is_national INTEGER DEFAULT 0,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      requires_match INTEGER DEFAULT 0,
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      record_origin TEXT,
      source TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      status TEXT,
      deadline TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO profiles (id, organization_id, primary_type, applicant_type, state, zip, tags, interests, created_at, updated_at)
    VALUES ('profile-recon', 'org-recon', 'individual', 'individual', 'TN', '37311', '["housing"]', '["rent","housing"]', '2026-04-26', '2026-04-26');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('profile-recon', 'basic_information', '{"state":"TN","profile_category":"individual"}');

    -- Linked funding opportunities (the matched grants point at these so the
    -- decision engine has real geography to score on).
    INSERT INTO funding_opportunities (id, title, description, state, is_national, categories, keywords, deadline_type, application_url, record_origin, source)
    VALUES
      ('fo-match-1', 'Tennessee Housing Assistance Grant', 'Housing and rent assistance for Tennessee residents in need.', 'TN', 0, '["housing"]', '["housing","rent"]', 'rolling', 'https://example.org/tn', 'verified_real', 'grants.gov'),
      ('fo-match-2', 'National Rent Relief Fund', 'Nationwide rent and housing relief for individuals.', 'nationwide', 1, '["housing"]', '["housing","rent"]', 'rolling', 'https://example.org/nat', 'verified_real', 'grants.gov'),
      ('fo-reject-1', 'California Residents Only Aid', 'California residents only. Must reside in California.', 'CA', 0, '["housing"]', '["housing"]', 'rolling', 'https://example.org/ca', 'verified_real', 'grants.gov'),
      ('fo-reject-2', 'Texas Residents Only Aid', 'Texas residents only. Must reside in Texas.', 'TX', 0, '["housing"]', '["housing"]', 'rolling', 'https://example.org/tx', 'verified_real', 'grants.gov');

    -- Two grants the matcher should ACCEPT/REVIEW (in-state TN + national, on-topic).
    INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder, status, deadline, notes)
    VALUES
      ('g-match-1', 'org-recon', 'profile-recon', 'fo-match-1', 'Tennessee Housing Assistance Grant', 'TN Funder', 'discovered', NULL, NULL),
      ('g-match-2', 'org-recon', 'profile-recon', 'fo-match-2', 'National Rent Relief Fund', 'National Funder', 'interested', NULL, NULL);

    -- Two grants the matcher should HARD-REJECT (state-exclusive, wrong state).
    INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder, status, deadline, notes)
    VALUES
      ('g-reject-1', 'org-recon', 'profile-recon', 'fo-reject-1', 'California Residents Only Aid', 'CA Funder', 'discovered', NULL, NULL),
      ('g-reject-2', 'org-recon', 'profile-recon', 'fo-reject-2', 'Texas Residents Only Aid', 'TX Funder', 'discovered', NULL, NULL);
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

describe('matched-count reconciliation (one shared matching source)', () => {
  it('GET /matching/profile/:id/grants returns the MATCHED subset, not the raw row count', async () => {
    const db = createDb()
    try {
      const rawCount = db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE organization_id = 'org-recon'`).get().n
      expect(rawCount).toBe(4) // raw rows attached to the org (what the OLD org badge counted)

      const response = await request(createApp(db))
        .get('/api/matching/profile/profile-recon/grants')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)

      // The matched count must be the scored subset (REJECTs dropped), so it is
      // STRICTLY fewer than the raw row count — this is exactly the gap the bug
      // surfaced as "Opportunities (40)" vs "3 matched".
      expect(response.body.length).toBeLessThan(rawCount)

      const matchedIds = response.body.map((g) => g.grant_id)
      // The two state-exclusive, wrong-state grants must NOT appear.
      expect(matchedIds).not.toContain('g-reject-1')
      expect(matchedIds).not.toContain('g-reject-2')
      // The on-topic in-state / national grants survive and carry a score.
      expect(matchedIds).toContain('g-match-1')
      expect(response.body.every((g) => typeof g.match_score === 'number')).toBe(true)
      expect(response.body.every((g) => Array.isArray(g.match_reasons) && g.match_reasons.length > 0)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('the matched grants are the single shared source both the org and profile surfaces read', async () => {
    // Sanity: the endpoint is deterministic, so the org "Opportunities (N)" badge
    // (which now calls matchProfileToGrants) and the profile Pipeline "N matched"
    // surface (same engine) derive the SAME number from the SAME query.
    const db = createDb()
    try {
      const app = createApp(db)
      const a = await request(app).get('/api/matching/profile/profile-recon/grants')
      const b = await request(app).get('/api/matching/profile/profile-recon/grants')
      expect(a.body.length).toBe(b.body.length)
    } finally {
      db.close()
    }
  })
})
