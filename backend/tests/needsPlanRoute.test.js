/**
 * /api/item-needs/:profileId/needs-plan[/search] — route contract.
 *
 * The service-level taxonomy is pinned in `orgNeedsTaxonomy.test.js`. This file
 * pins the WIRING, which is where the two defect classes that matter live:
 *
 *   1. THE SUPPRESSED NEED MUST NOT BE SEARCHED. A profile that already holds a
 *      CLIA certificate must not spend a live web query looking for CLIA
 *      funding. The test reads the exact `items` array handed to
 *      `searchItemNeeds`, so a regression that searches the whole blueprint
 *      fails here rather than quietly burning search budget in prod.
 *   2. A DARK BACKEND MUST NOT READ AS "NOTHING FOUND". `searchWeb` reports
 *      provider status on a non-enumerable `searchMeta` that `collectWebLeads`
 *      drops, so by the time results reach the route a 402'd Brave over a dead
 *      SearXNG is indistinguishable from a genuine zero. The route probes the
 *      providers and must say so. Asserted for `unconfigured` and `down`.
 */

import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchItemNeedsMock = vi.fn()
const probeHealthMock = vi.fn()
const loadProfileContextMock = vi.fn()
const tierMock = vi.fn(async () => true)

vi.mock('../services/itemNeedSearch.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, searchItemNeeds: searchItemNeedsMock }
})

vi.mock('../services/searchProviderHealth.js', () => ({
  probeSearchProviderHealth: probeHealthMock,
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
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT,
      status TEXT DEFAULT 'active', display_name TEXT, primary_type TEXT
    );
    INSERT INTO users (id, primary_email) VALUES
      ('owner', 'owner@test.local'), ('intruder', 'intruder@test.local');
    INSERT INTO profiles (id, user_id, display_name, primary_type)
      VALUES ('lab-1', 'owner', 'Axiom Bio Labs', 'research_lab');
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

/** A lab that already holds a CLIA cert, leases its space, and owns a freezer. */
const EQUIPPED_LAB_SECTIONS = {
  organization_details: {
    licenses_held: ['CLIA Certificate of Compliance'],
    facility_status: 'leased',
    equipment_owned: ['-80C freezer'],
    mission: 'Clinical diagnostic assays on patient specimens.',
  },
  financial_information: { item_needs: ['qPCR thermocycler'] },
}

let db
let app

beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  seed(db)
  app = createApp(db, { userId: 'owner', id: 'owner', email: 'owner@test.local' })

  loadProfileContextMock.mockResolvedValue({
    profile: { id: 'lab-1', display_name: 'Axiom Bio Labs', primary_type: 'research_lab' },
    sections: EQUIPPED_LAB_SECTIONS,
  })
  probeHealthMock.mockResolvedValue({
    verdict: 'healthy',
    detail: 'SearXNG responsive',
    probed_at: '2026-08-12T00:00:00.000Z',
  })
  searchItemNeedsMock.mockResolvedValue({
    profile_id: 'lab-1',
    requested_count: 5,
    searched_count: 5,
    truncated: 0,
    total_found: 0,
    total_awardable: 0,
    total_pointer: 0,
    items: [],
  })
})

describe('GET /api/item-needs/:profileId/needs-plan', () => {
  it('returns the research-lab plan with suppression evidence the owner can act on', async () => {
    const res = await request(app).get('/api/item-needs/lab-1/needs-plan').expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.blueprint).toEqual({ key: 'research_lab', source: 'profile_type' })

    const openCodes = res.body.open.map((n) => n.code)
    const suppressedCodes = res.body.suppressed.map((n) => n.code)

    expect(suppressedCodes).toContain('clinical_lab_certification')
    expect(suppressedCodes).toContain('facility_space')
    expect(openCodes).not.toContain('clinical_lab_certification')
    expect(openCodes).toContain('lab_consumables')

    // Evidence must name the field AND quote the value, so a wrong suppression
    // is visible and fixable rather than a silent disappearance.
    const clia = res.body.suppressed.find((n) => n.code === 'clinical_lab_certification')
    expect(clia.evidence.field).toBe('organization_details.licenses_held')
    expect(clia.evidence.value).toBe('CLIA Certificate of Compliance')

    // The owner's own words come back first-class.
    expect(res.body.user_added.map((n) => n.label)).toContain('qPCR thermocycler')

    // Conservation, across the wire.
    const accounted =
      res.body.open.length + res.body.suppressed.length + res.body.not_applicable.length + res.body.truncated
    expect(accounted).toBe(res.body.candidate_count)

    // The boxes that control suppression are named, so the UI can point at them.
    expect(res.body.evidence_fields).toContain('organization_details.licenses_held')
  })

  it('rejects an unknown profile id without throwing a 500', async () => {
    // `ensureProfileAccess` runs BEFORE the existence check and answers 403 for
    // an id outside the caller's accessible set — including ids that do not
    // exist. That is deliberate: a 404-vs-403 split here would let any caller
    // enumerate which profile ids are real. What must never happen is a 5xx,
    // which is what CI's `gate:endpoint-sweep` treats as a handler that threw.
    const res = await request(app).get('/api/item-needs/nope/needs-plan')
    expect(res.status).toBe(403)
    expect(res.status).toBeLessThan(500)
  })

  it('denies a profile the caller does not own', async () => {
    const intruderApp = createApp(db, { userId: 'intruder', id: 'intruder', email: 'intruder@test.local' })
    const res = await request(intruderApp).get('/api/item-needs/lab-1/needs-plan')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
  })
})

describe('POST /api/item-needs/:profileId/needs-plan/search', () => {
  it('searches ONLY the open needs — never one the profile already holds', async () => {
    await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)

    expect(searchItemNeedsMock).toHaveBeenCalledTimes(1)
    const passed = searchItemNeedsMock.mock.calls[0][1]
    const searched = passed.items.join(' | ').toLowerCase()

    // The suppressed needs' own search subjects must be absent. If a regression
    // searched the whole blueprint, these would appear and this fails.
    expect(searched).not.toContain('clia certification cost assistance')
    expect(searched).not.toContain('wet lab space grant')
    // …while a genuinely open need IS searched.
    expect(passed.items.length).toBeGreaterThan(0)
    expect(passed.profileId).toBe('lab-1')
  })

  it('reports an unconfigured search backend instead of presenting an empty list as an answer', async () => {
    probeHealthMock.mockResolvedValue({ verdict: 'unconfigured', detail: 'no SEARXNG_URL, no BRAVE_SEARCH_API_KEY' })

    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)

    expect(res.body.search_backends.verdict).toBe('unconfigured')
    expect(res.body.search_backends.message).toMatch(/unavailable/i)
    // The honesty that matters: a zero here is explicitly NOT a finding.
    expect(res.body.search_backends.message).toMatch(/does not mean nothing exists/i)
  })

  it('reports a DOWN backend the same way', async () => {
    probeHealthMock.mockResolvedValue({ verdict: 'down', detail: 'searxng unreachable' })
    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(res.body.search_backends.verdict).toBe('down')
    expect(res.body.search_backends.message).toMatch(/not responding/i)
  })

  it('a healthy backend carries no false warning', async () => {
    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(res.body.search_backends.verdict).toBe('healthy')
    expect(res.body.search_backends.message).toBeNull()
  })

  it('pages the plan instead of discarding the overflow', async () => {
    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(res.body.remaining).toBeGreaterThan(0)
    expect(res.body.next_offset).toBe(res.body.max_items_per_run)
    expect(res.body.plan_size).toBeGreaterThan(res.body.max_items_per_run)
  })

  it('REPORTS an unknown code rather than silently ignoring it', async () => {
    const res = await request(app)
      .post('/api/item-needs/lab-1/needs-plan/search')
      .send({ codes: ['lab_consumables', 'not_a_real_need'] })
      .expect(200)

    expect(res.body.unknown_codes).toEqual(['not_a_real_need'])
    const passed = searchItemNeedsMock.mock.calls[0][1]
    expect(passed.items).toHaveLength(1)
  })

  it('a code that is suppressed is reported as unknown, not silently searched', async () => {
    const res = await request(app)
      .post('/api/item-needs/lab-1/needs-plan/search')
      .send({ codes: ['clinical_lab_certification'] })
      .expect(200)

    // It is not in the searchable (open) set, so it is named and nothing runs.
    expect(res.body.unknown_codes).toEqual(['clinical_lab_certification'])
    expect(searchItemNeedsMock).not.toHaveBeenCalled()
    expect(res.body.searched_count).toBe(0)
    expect(res.body.note).toBeTruthy()
  })

  it('a person profile gets an honest explanation, not an empty result', async () => {
    loadProfileContextMock.mockResolvedValue({
      profile: { id: 'lab-1', display_name: 'A Student', primary_type: 'college_student' },
      sections: {},
    })
    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(searchItemNeedsMock).not.toHaveBeenCalled()
    expect(res.body.note).toMatch(/not an organization/i)
    // Even here the backend status is reported, so the caller never has to guess.
    expect(res.body.search_backends.verdict).toBe('healthy')
  })

  it('joins results to needs by SUBJECT, so a reordered/deduped response cannot mislabel', async () => {
    // `searchItemNeeds` dedupes its `items` by normalized text and could in
    // principle return them in a different order. An index-based join would
    // silently attach the wrong need identity to a result — a mislabelled
    // funding source is worse than a missing one. Returning the items REVERSED
    // is the cheapest way to prove the join does not depend on position.
    let passedItems = []
    searchItemNeedsMock.mockImplementation(async (_db, args) => {
      passedItems = args.items
      return {
        profile_id: 'lab-1',
        requested_count: args.items.length,
        searched_count: args.items.length,
        truncated: 0,
        total_found: 0,
        total_awardable: 0,
        total_pointer: 0,
        items: [...args.items].reverse().map((item) => ({ item, found: 0, results: [] })),
      }
    })

    // Ground truth: the plan itself maps each search subject to its label.
    const planRes = await request(app).get('/api/item-needs/lab-1/needs-plan').expect(200)
    const labelBySubject = new Map(
      [...planRes.body.open, ...planRes.body.user_added].map((n) => [n.search_subject, n.label]),
    )

    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(res.body.items.length).toBeGreaterThan(1)
    expect(res.body.items[0].item).toBe(passedItems[passedItems.length - 1])

    // THE ASSERTION THAT MATTERS: every row's label must be the label of ITS
    // OWN subject. Under an index join the rows are reversed relative to the
    // labels, so every row is mislabelled and this fails.
    for (const row of res.body.items) {
      expect(row.need_label, `row "${row.item}" must carry its own need's label`).toBe(
        labelBySubject.get(row.item),
      )
    }
  })

  it('never sends the same search subject twice in one run', async () => {
    await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    const passed = searchItemNeedsMock.mock.calls[0][1].items
    expect(new Set(passed.map((s) => s.toLowerCase())).size).toBe(passed.length)
  })

  it('attaches the need identity to each searched item', async () => {
    searchItemNeedsMock.mockResolvedValue({
      profile_id: 'lab-1',
      requested_count: 2,
      searched_count: 2,
      truncated: 0,
      total_found: 1,
      total_awardable: 1,
      total_pointer: 0,
      items: [
        { item: 'first', found: 1, results: [] },
        { item: 'second', found: 0, results: [] },
      ],
    })
    const res = await request(app).post('/api/item-needs/lab-1/needs-plan/search').send({}).expect(200)
    expect(res.body.items[0].need_code).toBeTruthy()
    expect(res.body.items[0].need_label).toBeTruthy()
    expect(res.body.items[0].need_source).toBe('profile_type_blueprint')
  })
})
