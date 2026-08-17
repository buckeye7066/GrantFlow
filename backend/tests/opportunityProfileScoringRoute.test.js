import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const requireAuthenticatedUser = vi.fn((req, res) => {
  if (!req.user || req.user.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return req.user
})
const ensureProfileAccess = vi.fn(async (req, res, profileId) => {
  if (req.user?.userId === 'owner-user' && profileId === 'profile-1') return true
  res.status(403).json({ error: 'Not authorized to access this profile' })
  return false
})
const loadProfileContext = vi.fn(async (_db, profileId) => ({
  profile: { id: profileId, primary_type: 'nonprofit' },
  sections: { basic_information: { state: 'OH' } },
  signals: { needs: new Set(['education']) },
}))
const scoreById = { 'opp-low': 10, 'opp-mid': 55, 'opp-high': 90 }
const computeMatchDecision = vi.fn((_profile, opportunity) => ({
  score: scoreById[opportunity.id] ?? 0,
  reasons: [`canonical:${opportunity.id}`],
  match_explain: { opportunity_id: opportunity.id },
  decision: (scoreById[opportunity.id] ?? 0) >= 60 ? 'ACCEPT' : 'REVIEW',
  confidence: 80,
  confidence_band: 'high',
  scoreScaleId: 'test-scale',
  matcherVersion: 'test-matcher',
  scoringPolicyVersion: 'test-policy',
  evaluatedAt: '2026-08-17T12:00:00.000Z',
}))

vi.mock('../utils/accessControl.js', () => ({ requireAuthenticatedUser, ensureProfileAccess }))
vi.mock('../services/profileHelpers.js', () => ({ loadProfileContext }))
vi.mock('../services/matchEngine.js', () => ({ computeMatchDecision }))
vi.mock('../services/canonicalMatchAuthority.js', () => ({
  assertCanonicalMatchDecision: (decision) => decision,
  canonicalMatchReceipt: (decision) => ({
    authority: 'matchEngine.computeMatchDecision',
    matcher_version: decision.matcherVersion,
    score_scale_id: decision.scoreScaleId,
    evaluated_at: decision.evaluatedAt,
  }),
}))
vi.mock('../utils/recordOrigins.js', () => ({
  trustedOriginClause: () => '1 = 1',
  trustedSourceClause: () => '1 = 1',
}))
vi.mock('../config/matchSurfacing.js', () => ({
  isOpportunityLifecycleVisible: () => true,
  opportunityLifecycleVisibility: () => ({ visible: true, reason: null }),
  opportunityLifecycleVisibilitySql: () => '1 = 1',
}))
vi.mock('../services/opportunityTrust.js', () => ({
  assessOpportunityTrust: () => ({ display: true, trustTier: 'high', reasons: [] }),
  buildTrustMetadata: () => ({ trust_tier: 'high', trust_flags: [], trust_reasons: [] }),
}))
vi.mock('../services/pipelineExclusion.js', () => ({
  filterOutPipelineMembers: async (_db, _profileId, rows) => ({ results: rows }),
  dedupeOpportunityList: (rows) => ({ results: rows }),
}))
vi.mock('../services/opportunityContract.js', () => ({
  buildOpportunityReadModel: (row) => ({
    canonical_opportunity_id: row.id,
    current_status: 'open',
    status_label: 'Open',
  }),
}))
vi.mock('../services/opportunityRepository.js', () => ({
  createOpportunity: vi.fn(),
  listOpportunityChanges: vi.fn(async () => []),
  syncOpportunityContractProjection: vi.fn(),
}))

const opportunitiesRouter = (await import('../routes/opportunities.js')).default

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      description TEXT,
      keywords TEXT,
      deadline TEXT,
      deadline_type TEXT,
      type TEXT,
      record_origin TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      application_url TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      opportunity_type TEXT,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT INTO funding_opportunities
      (id, title, sponsor, deadline, source_id, source_url, application_url, state, created_at)
    VALUES
      ('opp-low', 'Low score', 'Funder', '2026-09-01', 'low', 'https://example.test/low', 'https://example.test/low', 'OH', '2026-08-01'),
      ('opp-mid', 'Mid score', 'Funder', '2026-10-01', 'mid', 'https://example.test/mid', 'https://example.test/mid', 'OH', '2026-08-02'),
      ('opp-high', 'High score', 'Funder', '2026-11-01', 'high', 'https://example.test/high', 'https://example.test/high', 'OH', '2026-08-03');
  `)
  return db
}

function appWith(db) {
  const app = express()
  app.use((req, _res, next) => {
    req.db = db
    req.user = req.headers['x-test-user'] === 'owner'
      ? { role: 'user', userId: 'owner-user' }
      : req.headers['x-test-user'] === 'other'
        ? { role: 'user', userId: 'other-user' }
        : { role: 'guest' }
    next()
  })
  app.use('/api/opportunities', opportunitiesRouter)
  return app
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
})
afterEach(() => {
  db?.close()
  db = null
})

describe('profile-scored opportunity routes', () => {
  it('ranks the full primary-list candidate set before applying pagination', async () => {
    const first = await request(appWith(db))
      .get('/api/opportunities?profile_id=profile-1&compliance=all&limit=1&offset=0')
      .set('x-test-user', 'owner')
    const second = await request(appWith(db))
      .get('/api/opportunities?profile_id=profile-1&compliance=all&limit=1&offset=1')
      .set('x-test-user', 'owner')

    expect(first.status).toBe(200)
    expect(first.body.total).toBe(3)
    expect(first.body.data).toHaveLength(1)
    expect(first.body.data[0]).toMatchObject({
      id: 'opp-high',
      match_score: 90,
      match_reasons: ['canonical:opp-high'],
      match_decision: 'ACCEPT',
      match_authority: { authority: 'matchEngine.computeMatchDecision' },
    })
    expect(second.body.data[0].id).toBe('opp-mid')
    expect(ensureProfileAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'profile-1')
    expect(computeMatchDecision).toHaveBeenCalledTimes(6)
  })

  it('authorizes and globally ranks the geo fallback before pagination', async () => {
    const response = await request(appWith(db))
      .get('/api/opportunities/geo/scored?state=OH&profile_id=profile-1&limit=1&offset=0')
      .set('x-test-user', 'owner')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      profile_id: 'profile-1',
      total: 3,
    })
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'opp-high',
      match_score: 90,
      match_reasons: ['canonical:opp-high'],
      match_explain: { opportunity_id: 'opp-high' },
      match_authority: { authority: 'matchEngine.computeMatchDecision' },
    })
    expect(loadProfileContext).toHaveBeenCalledWith(db, 'profile-1')
  })

  it('fails closed before loading another tenant profile on both scored endpoints', async () => {
    const primaryAnonymous = await request(appWith(db))
      .get('/api/opportunities?profile_id=profile-1')
    const primaryForeign = await request(appWith(db))
      .get('/api/opportunities?profile_id=profile-2')
      .set('x-test-user', 'other')
    const geoForeign = await request(appWith(db))
      .get('/api/opportunities/geo/scored?state=OH&profile_id=profile-2')
      .set('x-test-user', 'other')

    expect(primaryAnonymous.status).toBe(401)
    expect(primaryForeign.status).toBe(403)
    expect(geoForeign.status).toBe(403)
    expect(loadProfileContext).not.toHaveBeenCalled()
    expect(computeMatchDecision).not.toHaveBeenCalled()
  })
})
