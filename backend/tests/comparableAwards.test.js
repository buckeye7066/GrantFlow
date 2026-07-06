/**
 * Tests for the comparable-awards grounding lane:
 *   1. Query builder derives real keyword terms (no stopword junk, bounded).
 *   2. Flag OFF (default) → { enabled:false, awards:[] } and NO external call.
 *   3. Flag ON → rows come straight from the (mocked) RePORTER integration —
 *      passed through unmodified, never padded or invented (G0).
 *   4. Route access control: 401 unauthenticated, 404 unknown grant, 403 for
 *      a user without access to the grant's profile/org, 200 for the owner.
 */

import express from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../src/integrations/nihReporter.js', () => ({
  fetchOpportunities: vi.fn(async () => []),
  fetchComparableAwards: vi.fn(async () => [
    {
      title: 'Real NIH Award A',
      recipient: 'State University',
      recipient_state: 'TN',
      amount: 250000,
      agency: 'NINDS',
      detail_url: 'https://reporter.nih.gov/project-details/123',
      project_start: '2024-01-01',
      project_end: '2026-01-01',
      source: 'nih.reporter',
      reference_only: true,
    },
  ]),
}))

const { fetchComparableAwards } = await import('../src/integrations/nihReporter.js')
const {
  buildComparableAwardsQuery,
  fetchComparableAwardsForGrant,
  COMPARABLE_AWARDS_LABEL,
} = await import('../services/comparableAwardsService.js')
const aiRouter = (await import('../routes/ai.js')).default

const savedFlag = process.env.COMPARABLE_AWARDS
afterEach(() => {
  if (savedFlag === undefined) delete process.env.COMPARABLE_AWARDS
  else process.env.COMPARABLE_AWARDS = savedFlag
  vi.clearAllMocks()
})

describe('buildComparableAwardsQuery', () => {
  it('prefers opportunity keywords/categories over title tokens and drops stopwords', () => {
    const query = buildComparableAwardsQuery(
      { title: 'The Grant Program for Rural Nursing Education' },
      { keywords: '["nursing","rural health"]', categories: ['education'], description: '' },
    )
    expect(query).toContain('nursing')
    expect(query).toContain('rural health')
    expect(query).toContain('education')
    expect(query).not.toMatch(/\bthe\b/)
    expect(query).not.toMatch(/\bprogram\b/)
    expect(query.split(' ').length).toBeLessThanOrEqual(12)
  })

  it('returns empty string when there is nothing real to search on', () => {
    expect(buildComparableAwardsQuery({ title: 'The For And' }, null)).toBe('')
  })
})

describe('fetchComparableAwardsForGrant', () => {
  it('is disabled by default (flag off) and does not call the live API', async () => {
    delete process.env.COMPARABLE_AWARDS
    const result = await fetchComparableAwardsForGrant(null, { id: 'g1', title: 'Nursing scholarship' })
    expect(result.enabled).toBe(false)
    expect(result.awards).toEqual([])
    expect(fetchComparableAwards).not.toHaveBeenCalled()
  })

  it('flag ON: returns real rows from the integration unmodified — never padded', async () => {
    process.env.COMPARABLE_AWARDS = '1'
    const result = await fetchComparableAwardsForGrant(null, { id: 'g1', title: 'Rural nursing education award' })
    expect(result.enabled).toBe(true)
    expect(result.awards).toHaveLength(1)
    expect(result.awards[0]).toMatchObject({
      title: 'Real NIH Award A',
      recipient: 'State University',
      reference_only: true,
    })
    expect(fetchComparableAwards).toHaveBeenCalledOnce()
  })
})

// ── route access control ─────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      organization_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      keywords TEXT,
      categories TEXT
    );
  `)
  db.prepare(
    `INSERT INTO grants (id, profile_id, organization_id, title, funder)
     VALUES ('grant-1', 'profile-1', 'org-1', 'Nursing Education Grant', 'Health Foundation')`,
  ).run()
  return db
}

function createApp(db, ctxOverride) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    if (ctxOverride !== null) {
      req.user = { id: 'user-1', userId: 'user-1', role: 'user' }
      req.ctx = ctxOverride
    }
    next()
  })
  app.use('/api/ai', aiRouter)
  return app
}

describe('GET /api/ai/comparable-awards access control', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('401s unauthenticated requests', async () => {
    const res = await request(createApp(db, null)).get('/api/ai/comparable-awards?grant_id=grant-1')
    expect(res.status).toBe(401)
  })

  it('400s a missing grant_id', async () => {
    const ctx = { userId: 'user-1', isAdmin: false, accessibleOrgIds: new Set(), accessibleProfileIds: new Set(['profile-1']) }
    const res = await request(createApp(db, ctx)).get('/api/ai/comparable-awards')
    expect(res.status).toBe(400)
  })

  it('404s an unknown grant', async () => {
    const ctx = { userId: 'user-1', isAdmin: false, accessibleOrgIds: new Set(), accessibleProfileIds: new Set(['profile-1']) }
    const res = await request(createApp(db, ctx)).get('/api/ai/comparable-awards?grant_id=nope')
    expect(res.status).toBe(404)
  })

  it("403s a user without access to the grant's profile/org", async () => {
    const ctx = { userId: 'user-2', isAdmin: false, accessibleOrgIds: new Set(['other-org']), accessibleProfileIds: new Set(['other-profile']) }
    const res = await request(createApp(db, ctx)).get('/api/ai/comparable-awards?grant_id=grant-1')
    expect(res.status).toBe(403)
  })

  it('200s for the profile owner, labeled reference-only, honest when flag is off', async () => {
    delete process.env.COMPARABLE_AWARDS
    const ctx = { userId: 'user-1', isAdmin: false, accessibleOrgIds: new Set(), accessibleProfileIds: new Set(['profile-1']) }
    const res = await request(createApp(db, ctx)).get('/api/ai/comparable-awards?grant_id=grant-1')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.data).toEqual([])
    expect(res.body.label).toBe(COMPARABLE_AWARDS_LABEL)
  })

  it('200s with real mocked rows when the flag is on', async () => {
    process.env.COMPARABLE_AWARDS = '1'
    const ctx = { userId: 'user-1', isAdmin: false, accessibleOrgIds: new Set(), accessibleProfileIds: new Set(['profile-1']) }
    const res = await request(createApp(db, ctx)).get('/api/ai/comparable-awards?grant_id=grant-1')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('Real NIH Award A')
    expect(res.body.data[0].reference_only).toBe(true)
  })
})
