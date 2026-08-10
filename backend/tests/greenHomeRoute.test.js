import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchGreenMock = vi.fn()
const loadProfileContextMock = vi.fn()
const tierMock = vi.fn(async () => true)

vi.mock('../services/greenHomeNoCostSearch.js', () => ({
  searchGreenHomeNoCostPrograms: searchGreenMock,
}))

vi.mock('../services/profileHelpers.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, loadProfileContext: loadProfileContextMock }
})

vi.mock('../utils/tierGating.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, requireTierCapability: tierMock }
})

const itemNeedsRouter = (await import('../routes/itemNeeds.js')).default

function seed(db) {
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
      status TEXT DEFAULT 'active',
      display_name TEXT,
      primary_type TEXT
    );
    INSERT INTO users (id, primary_email) VALUES
      ('owner', 'owner@test.local'),
      ('intruder', 'intruder@test.local');
    INSERT INTO profiles (id, user_id, display_name, primary_type)
      VALUES ('profile-owned', 'owner', 'Owner Household', 'individual');
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
  app.use('/api/item-needs', itemNeedsRouter)
  return app
}

function greenResponse() {
  return {
    success: true,
    profile_id: 'profile-owned',
    policy_version: 'green_home_no_cost_v1',
    strict_no_cost: true,
    count: 1,
    programs: [{
      id: 'wap',
      title: 'Weatherization Assistance Program',
      no_cost_classification: 'eligible',
      opportunity_kind: 'directory',
      source_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
    }],
    review_count: 2,
    review_reasons: [{ reason: 'no_cost_not_proven', count: 2 }],
    excluded_count: 3,
    excluded_reasons: [
      { reason: 'loan_or_financing', count: 1 },
      { reason: 'tax_credit', count: 1 },
      { reason: 'rebate', count: 1 },
    ],
  }
}

describe('POST /api/item-needs/:profileId/green-home', () => {
  beforeEach(() => {
    searchGreenMock.mockReset()
    searchGreenMock.mockResolvedValue(greenResponse())
    tierMock.mockClear()
    tierMock.mockResolvedValue(true)
    loadProfileContextMock.mockReset()
    loadProfileContextMock.mockResolvedValue({
      profile: {
        id: 'profile-owned',
        user_id: 'owner',
        display_name: 'Owner Household',
        primary_type: 'individual',
        state: 'TN',
        is_homeowner: true,
      },
      sections: {},
    })
  })

  it('returns the strict result contract to the authorized profile owner', async () => {
    const db = new Database(':memory:')
    try {
      seed(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })
      const response = await request(app)
        .post('/api/item-needs/profile-owned/green-home')
        .send({})

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        success: true,
        profile_id: 'profile-owned',
        strict_no_cost: true,
        count: 1,
        review_count: 2,
        excluded_count: 3,
      })
      expect(response.body.programs[0].no_cost_classification).toBe('eligible')
      expect(response.body).not.toHaveProperty('review_programs')
      expect(searchGreenMock).toHaveBeenCalledTimes(1)
      expect(searchGreenMock.mock.calls[0][1]).toMatchObject({
        profileId: 'profile-owned',
        profileContext: expect.objectContaining({
          profile: expect.objectContaining({ id: 'profile-owned', state: 'TN' }),
        }),
      })
      expect(tierMock).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('rejects cross-tenant access before searching', async () => {
    const db = new Database(':memory:')
    try {
      seed(db)
      const app = createApp(db, { userId: 'intruder', role: 'user' })
      const response = await request(app)
        .post('/api/item-needs/profile-owned/green-home')
        .send({})

      expect(response.status).toBe(403)
      expect(searchGreenMock).not.toHaveBeenCalled()
      expect(tierMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('does not search when the tier capability gate refuses access', async () => {
    tierMock.mockImplementationOnce(async (_req, res) => {
      res.status(403).json({ error: 'item funding not included' })
      return false
    })
    const db = new Database(':memory:')
    try {
      seed(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })
      const response = await request(app)
        .post('/api/item-needs/profile-owned/green-home')
        .send({})

      expect(response.status).toBe(403)
      expect(searchGreenMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('preserves a typed service failure instead of reporting an empty success', async () => {
    const error = new Error('green-home provider search unavailable')
    error.statusCode = 503
    searchGreenMock.mockRejectedValueOnce(error)
    const db = new Database(':memory:')
    try {
      seed(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })
      const response = await request(app)
        .post('/api/item-needs/profile-owned/green-home')
        .send({})

      expect(response.status).toBe(503)
      expect(response.body).not.toMatchObject({ success: true, programs: [] })
    } finally {
      db.close()
    }
  })
})
