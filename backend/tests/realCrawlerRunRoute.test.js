import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REVIEW_SCORE,
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'

const { runProfileDiscoveryLiveMock } = vi.hoisted(() => ({
  runProfileDiscoveryLiveMock: vi.fn(),
}))

vi.mock('../services/crawlerOsService.js', () => ({
  runProfileDiscoveryLive: runProfileDiscoveryLiveMock,
  isWebDiscoveryEnabled: vi.fn(() => false),
}))

const realCrawlersRouter = (await import('../routes/realCrawlers.js')).default

function seedSchema(db) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      record_origin TEXT,
      description TEXT,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      opportunity_kind TEXT,
      deadline TEXT,
      deadline_type TEXT,
      amount_min REAL,
      amount_max REAL,
      state TEXT,
      categories TEXT DEFAULT '[]',
      funding_type TEXT,
      link_status TEXT,
      reality_status TEXT,
      reality_reasons TEXT,
      verification_status TEXT,
      last_verified_at TEXT,
      source_trust_tier TEXT,
      final_url TEXT,
      http_status INTEGER,
      result_kind TEXT,
      is_hidden INTEGER DEFAULT 0,
      is_loan INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_confidence REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      match_explain_json TEXT DEFAULT '{}',
      matcher_version TEXT NOT NULL,
      PRIMARY KEY (profile_id, opportunity_id)
    );

    INSERT INTO users (id, primary_email, is_admin) VALUES
      ('owner', 'owner@test.local', 0),
      ('intruder', 'intruder@test.local', 0);
    INSERT INTO profiles (id, user_id, created_by, status)
      VALUES ('profile-owned', 'owner', 'owner', 'active');
  `)
}

function createApp(db, user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.db = db
    req.ctx = { userId: user?.userId, isAdmin: false }
    next()
  })
  app.use('/api/real-crawlers', realCrawlersRouter)
  return app
}

function seedLifecycleResults(db, profileId) {
  const rows = [
    { id: 'visible-direct', kind: 'DIRECT_GRANT', hidden: 0, active: 1, decision: 'ACCEPT', score: STRONG_MATCH_SCORE },
    { id: 'hidden-direct', kind: 'DIRECT_GRANT', hidden: 1, active: 1, decision: 'ACCEPT', score: STRONG_MATCH_SCORE },
    { id: 'inactive-direct', kind: 'DIRECT_GRANT', hidden: 0, active: 0, decision: 'ACCEPT', score: STRONG_MATCH_SCORE },
    { id: 'hidden-pointer', kind: 'DIRECTORY', hidden: 1, active: 1, decision: 'REVIEW', score: REVIEW_SCORE },
    { id: 'visible-pointer', kind: 'DIRECTORY', hidden: 0, active: 1, decision: 'REVIEW', score: REVIEW_SCORE },
  ]
  for (const row of rows) {
    db.prepare(`
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, record_origin, description,
        application_url, source_url, opportunity_kind, deadline_type,
        state, link_status, reality_status, verification_status,
        source_trust_tier, is_hidden, is_active
      ) VALUES (?, ?, ?, 'official-state', 'verified_real', ?, ?, ?, ?, 'rolling',
                'OH', 'verified', 'allowed', 'verified', 'official', ?, ?)
    `).run(
      row.id,
      `Lifecycle ${row.id}`,
      'Ohio Public Agency',
      `Official lifecycle fixture for ${row.id}.`,
      `https://ohio.gov/funding/${row.id}/apply`,
      `https://ohio.gov/funding/${row.id}`,
      row.kind,
      row.hidden,
      row.active,
    )
    db.prepare(`
      INSERT INTO profile_opportunity_matches (
        profile_id, opportunity_id, match_score, match_decision,
        match_explanation, match_reasons, match_explain_json, matcher_version
      ) VALUES (?, ?, ?, ?, 'Persisted lifecycle fixture.', '[]', ?, 'crawler-os')
    `).run(profileId, row.id, row.score, row.decision,
      row.decision === 'ACCEPT'
        ? verifiedFourTruthExplain()
        // A POINTER carries the four gates in their pointer sense
        // (crawler-os/pointerTruthPolicy.js): tied to this profile
        // geographically, serving a recorded need, scored against its data
        // points. This fixture exercises LIFECYCLE, so it states that evidence
        // rather than relying on the exemption the pointer arm used to grant.
        : JSON.stringify({
          matched_location: 'state',
          matched_profile_type: true,
          matched_needs: ['housing'],
          matched_profile_facts: ['Profile signal: geo:state'],
        }))
  }
}

describe('POST /api/real-crawlers/run Crawler OS authority', () => {
  beforeEach(() => {
    runProfileDiscoveryLiveMock.mockReset()
  })

  it('returns the exact persisted canonical score and decision to the authorized owner', async () => {
    const persistedScore = 13
    runProfileDiscoveryLiveMock.mockImplementation(async ({
      db,
      profileId,
      floor,
      crawlerType,
    }) => {
      expect(profileId).toBe('profile-owned')
      expect(floor).toBe(STRONG_MATCH_SCORE)
      expect(crawlerType).toBe('comprehensive')
      db.prepare(`
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, record_origin, description,
          application_url, source_url, opportunity_kind, deadline,
          deadline_type, amount_min, amount_max, state, link_status,
          reality_status, verification_status, source_trust_tier, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        'official-opportunity',
        'Ohio Workforce Credential Grant',
        'Ohio Department of Higher Education',
        'ohio-official',
        'live_crawl',
        'Official credential assistance for eligible Ohio residents.',
        'https://highered.ohio.gov/credential-grant/apply',
        'https://highered.ohio.gov/credential-grant',
        'DIRECT_GRANT',
        '2026-12-31',
        'fixed',
        500,
        2500,
        'OH',
        'verified',
        'allowed',
        'verified',
        'official',
      )
      db.prepare(`
        INSERT INTO profile_opportunity_matches (
          profile_id, opportunity_id, match_score, match_decision,
          match_explanation, match_reasons, match_explain_json, matcher_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profileId,
        'official-opportunity',
        persistedScore,
        'ACCEPT',
        'Persisted canonical Crawler OS decision.',
        '["ohio residency"]',
        verifiedFourTruthExplain({ why: 'Persisted canonical Crawler OS decision.' }),
        'crawler-os',
      )
      db.prepare(`
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, record_origin, description,
          application_url, source_url, opportunity_kind, deadline,
          deadline_type, amount_min, amount_max, state, link_status,
          reality_status, verification_status, source_trust_tier, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        'review-opportunity',
        'Ohio Credential Resource',
        'Ohio Workforce Agency',
        'ohio-official',
        'live_crawl',
        'Official credential resource for Ohio residents.',
        'https://workforce.ohio.gov/credential-resource/apply',
        'https://workforce.ohio.gov/credential-resource',
        'DIRECT_PROGRAM',
        '2026-12-31',
        'fixed',
        250,
        1000,
        'OH',
        'verified',
        'allowed',
        'verified',
        'official',
      )
      db.prepare(`
        INSERT INTO profile_opportunity_matches (
          profile_id, opportunity_id, match_score, match_decision,
          match_explanation, match_reasons, match_explain_json, matcher_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profileId,
        'review-opportunity',
        persistedScore,
        'REVIEW',
        'Persisted canonical review decision.',
        '["ohio residency"]',
        '{"why":"Persisted canonical review decision."}',
        'crawler-os',
      )
      return {
        run: {
          stored: 2,
          sources: [{ source_id: 'ohio-official', stored: 2 }],
          rejected: 0,
        },
        persisted: { opportunities: 2, matches: 2 },
      }
    })

    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/run')
        .send({
          profile_id: 'profile-owned',
          crawler_type: 'comprehensive',
          min_match_score: 99,
        })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        success: true,
        engine: 'crawler-os',
        crawler_type: 'comprehensive',
        profile_id: 'profile-owned',
        score_scale_id: SCORE_SCALE_ID,
        min_match_score: STRONG_MATCH_SCORE,
        count: 1,
        total_found: 1,
        display_preference_excluded: 0,
      })
      expect(res.body.results).toHaveLength(1)
      expect(res.body.results[0]).toMatchObject({
        id: 'official-opportunity',
        match_score: persistedScore,
        match_decision: 'ACCEPT',
        matcher_version: 'crawler-os',
      })
      expect(res.body.opportunities).toEqual(res.body.results)
      expect(runProfileDiscoveryLiveMock).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('returns non-2xx success:false and no results when Crawler OS persistence fails', async () => {
    runProfileDiscoveryLiveMock.mockRejectedValue(new Error('profile match persistence failed'))
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/run')
        .send({ profile_id: 'profile-owned', crawler_type: 'comprehensive' })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.body).toMatchObject({
        success: false,
        crawler_type: 'comprehensive',
        profile_id: 'profile-owned',
      })
      expect(res.body.error).toContain('persistence failed')
      expect(res.body).not.toHaveProperty('results')
      expect(res.body).not.toHaveProperty('opportunities')
    } finally {
      db.close()
    }
  })

  it.each([
    ['/api/real-crawlers/run', { crawler_type: 'comprehensive', min_match_score: REVIEW_SCORE }],
    ['/api/real-crawlers/run-smart', { min_match_score: REVIEW_SCORE }],
  ])('%s excludes hidden/inactive rows while keeping a visible typed pointer', async (path, body) => {
    runProfileDiscoveryLiveMock.mockImplementation(async ({ db, profileId }) => {
      seedLifecycleResults(db, profileId)
      return {
        run: { stored: 5, sources: [{ source_id: 'official-state', stored: 5 }], rejected: 0 },
        persisted: { opportunities: 5, matches: 5 },
      }
    })
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post(path)
        .send({ profile_id: 'profile-owned', ...body })

      expect(res.status).toBe(200)
      const opportunities = res.body.opportunities ?? res.body.results
      expect(opportunities.map((row) => row.id)).toEqual([
        'visible-direct',
        'visible-pointer',
      ])
      expect(opportunities.find((row) => row.id === 'visible-pointer')).toMatchObject({
        opportunity_kind: 'DIRECTORY',
        is_directory_resource: true,
      })
      expect(JSON.stringify(res.body)).not.toMatch(/hidden-direct|inactive-direct|hidden-pointer/)
    } finally {
      db.close()
    }
  })

  it('denies cross-profile access before invoking Crawler OS', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'intruder', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/run')
        .send({ profile_id: 'profile-owned', crawler_type: 'comprehensive' })

      expect(res.status).toBe(403)
      expect(runProfileDiscoveryLiveMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects a missing profile id before invoking Crawler OS', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/run')
        .send({ crawler_type: 'comprehensive' })

      expect(res.status).toBe(400)
      expect(runProfileDiscoveryLiveMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects an unknown profile before invoking Crawler OS', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/run')
        .send({ profile_id: 'profile-missing', crawler_type: 'comprehensive' })

      expect(res.status).toBe(403)
      expect(runProfileDiscoveryLiveMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
