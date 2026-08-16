/**
 * GET /api/item-needs/:profileId — insurance eligibility-hint WIRING.
 *
 * planCoverage.test.js pins the registry/resolvers; this file pins that the
 * route actually consults them: a profile declaring an ECF CHOICES waiver
 * enrollment + a grip impairment gets its adaptive-equipment item annotated
 * with the waiver hint (and the response carries `plan_classes` /
 * `condition_classes` so the UI can explain the label), while a profile with
 * no insurance facts gets the IDENTICAL list with zero hints — the
 * labeling-layer-only doctrine, asserted at the HTTP contract.
 */
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadProfileContextMock = vi.fn()
const tierMock = vi.fn(async () => true)

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
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT,
      status TEXT DEFAULT 'active', display_name TEXT, primary_type TEXT
    );
    INSERT INTO users (id, primary_email) VALUES ('owner', 'owner@test.local');
    INSERT INTO profiles (id, user_id, display_name, primary_type)
      VALUES ('person-1', 'owner', 'ECF Member', 'individual');
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

// The real prod shapes, verbatim field content.
const HEALTH_SECTIONS = {
  health_medical: { disability_type: ['Clawing effect in hands'] },
}
const INSURED_SECTIONS = {
  ...HEALTH_SECTIONS,
  government_assistance: { other_programs: 'Medicaid Waiver Program (ECF CHOICES - TN)' },
}

let db
let app

beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  seed(db)
  app = createApp(db, { userId: 'owner', id: 'owner', email: 'owner@test.local' })
})

function mockSections(sections) {
  loadProfileContextMock.mockResolvedValue({
    profile: { id: 'person-1', display_name: 'ECF Member', primary_type: 'individual' },
    sections,
  })
}

describe('GET /api/item-needs/:profileId — coverage hints', () => {
  it('an insured grip-impaired member gets the waiver hint on the adaptive item', async () => {
    mockSections(INSURED_SECTIONS)
    const res = await request(app).get('/api/item-needs/person-1').expect(200)

    expect(res.body.plan_classes).toContain('medicaid_waiver')
    expect(res.body.condition_classes).toContain('mobility_impairment')

    const adl = res.body.needs.find((n) => /built-up utensils/i.test(n.item))
    expect(adl).toBeTruthy()
    expect(adl.eligibility_hint?.plan_class).toBe('medicaid_waiver')
    expect(adl.eligibility_hint?.note).toMatch(/check with your plan/i)
  })

  it('the SAME profile without insurance facts gets the SAME list with zero hints', async () => {
    mockSections(HEALTH_SECTIONS)
    const res = await request(app).get('/api/item-needs/person-1').expect(200)

    expect(res.body.plan_classes).toEqual([])
    const adl = res.body.needs.find((n) => /built-up utensils/i.test(n.item))
    expect(adl).toBeTruthy() // membership unchanged — the hint layer never gates
    expect(res.body.needs.every((n) => n.eligibility_hint === undefined)).toBe(true)
  })
})
