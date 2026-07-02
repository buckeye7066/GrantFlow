/**
 * POST /api/real-crawlers/specific-need — the Item Funding page's live search.
 *
 * Owner-stated goal (verbatim): "item funding, where the user searches for a
 * specific item, like a passenger van, or help to pay for an Ethics Probe
 * Class" — a concrete need must produce REAL funding leads.
 *
 * Pins the route contract with the two acceptance queries mocked at the
 * web-search boundary (network-independent):
 *   1. "passenger van" — catalog has nothing; the need-keyed LIVE WEB lane
 *      must surface labeled leads (result_source='web_search') with the exact
 *      URLs the search returned (canonical G0: no fabrication).
 *   2. "help to pay for an Ethics Probe Class" — taxonomy routes to
 *      license-reinstatement; a matching curated program is re-ranked to the
 *      top AND web leads are appended. A non-student individual is not blocked.
 *   3. Gateway budget: an overrunning live crawl yields partial results from
 *      the persisted catalog (200 + timed_out), never a 504.
 *   4. WEB_DISCOVERY_ENABLED=false → honest web_search.attempted=false.
 *   5. Profile access is enforced (403, no web search dispatched).
 *
 * The live crawl + persisted-results reads are mocked; the web-lead pipeline
 * (query building, scoring, dedupe, labeling) runs for REAL down to the mocked
 * searchWeb call.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

// Keep the acceptance tests fast: bound the whole handler like prod does, with
// a small budget so the hang-simulation test resolves in ~1.5s (remainingBudget
// floors each slice at 1500ms). Must be set BEFORE the route module is imported
// (the budget constants are module-scoped).
process.env.CRAWL_TOTAL_BUDGET_MS = '2000'
process.env.CRAWL_FALLBACK_RESERVE_MS = '100'

const runLiveMock = vi.fn()
const loadResultsMock = vi.fn()
const searchWebMock = vi.fn()

vi.mock('../services/crawlerOsService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runProfileDiscoveryLive: (...a) => runLiveMock(...a) }
})

vi.mock('../services/crawlerOsCompatibility.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    stampLastDiscoveryAt: async () => {},
    loadCrawlerOsProfileResults: (...a) => loadResultsMock(...a),
  }
})

vi.mock('../services/shared/webSearchEngine.js', () => ({
  searchWeb: (...a) => searchWebMock(...a),
  default: { searchWeb: (...a) => searchWebMock(...a) },
}))

const realCrawlersRouter = (await import('../routes/realCrawlers.js')).default

function seedSchema(db) {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, status TEXT DEFAULT 'active', primary_type TEXT, display_name TEXT, state TEXT);
    INSERT INTO users (id, primary_email) VALUES ('owner', 'owner@test.local'), ('intruder', 'intruder@test.local');
    INSERT INTO profiles (id, user_id, primary_type, display_name, state)
      VALUES ('profile-owned', 'owner', 'nonprofit', 'Cleveland Community Outreach', 'TN');
  `)
}

function createApp(db, user, { isAdmin = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.db = db
    req.ctx = { userId: user?.userId, isAdmin }
    next()
  })
  app.use('/api/real-crawlers', realCrawlersRouter)
  return app
}

const OK_RUN = { run: { sources: [], rejected: 0 }, persisted: { opportunities: 0, matches: 0 } }

const VAN_WEB_HITS = [
  {
    url: 'https://www.mass.gov/how-to/apply-for-an-accessible-vehicle',
    title: 'Apply for an accessible vehicle through the Community Transit Grant Program',
    snippet: 'Nonprofit organizations may apply for a passenger van through the grant program.',
  },
  {
    url: 'https://www.communitytransit.org/van-go',
    title: 'Van GO surplus passenger van awards for nonprofits',
    snippet: 'Community Transit awards surplus passenger vans to local nonprofits.',
  },
]

const PROBE_WEB_HITS = [
  {
    url: 'https://www.cpepdoc.org/cpep-courses/probe-ethics-boundaries-program',
    title: 'PROBE: Ethics & Boundaries Program',
    snippet: 'The PROBE ethics course is a board-required professional boundaries course; financial assistance reinstatement options are listed.',
  },
]

const PROBE_CURATED_RESULT = {
  id: 'os-probe-1',
  name: 'Tennessee Nurse Re-entry Course Assistance',
  description:
    'Assistance paying for the board-required PROBE ethics and boundaries course for nursing license reinstatement. Covers reinstatement course fees.',
  categories: ['license_reinstatement_support'],
  matchScore: 70,
  matchReasons: ['Profile is a licensed professional seeking reinstatement'],
  url: 'https://example.org/tn-nurse-reentry',
  applicationUrl: 'https://example.org/tn-nurse-reentry/apply',
  type: 'benefit',
}

describe('POST /api/real-crawlers/specific-need', () => {
  beforeEach(() => {
    runLiveMock.mockReset().mockResolvedValue(OK_RUN)
    loadResultsMock.mockReset().mockResolvedValue([])
    searchWebMock.mockReset().mockResolvedValue([])
    delete process.env.WEB_DISCOVERY_ENABLED
  })
  afterEach(() => {
    delete process.env.WEB_DISCOVERY_ENABLED
  })

  it('acceptance 1 — "passenger van": empty catalog still yields REAL, labeled live web leads', async () => {
    searchWebMock.mockResolvedValue(VAN_WEB_HITS)
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned', need_text: 'passenger van', min_match_score: 15, max_results: 40 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.engine).toBe('crawler-os')

      // The need-keyed web lane ran with need-anchored queries.
      expect(searchWebMock).toHaveBeenCalled()
      expect(res.body.web_search.attempted).toBe(true)
      expect(res.body.web_search.queries.some((q) => q.toLowerCase().includes('passenger van'))).toBe(true)

      // Zero catalog rows must NOT mean zero results (canonical G2).
      expect(res.body.count).toBeGreaterThan(0)
      expect(res.body.web_search_results).toBeGreaterThan(0)

      const leads = res.body.opportunities.filter((o) => o.result_source === 'web_search')
      expect(leads.length).toBe(VAN_WEB_HITS.length)
      for (const lead of leads) {
        // Honest provenance + the EXACT URL the search returned (G0: no fabrication).
        expect(lead.record_origin).toBe('web_search')
        expect(VAN_WEB_HITS.map((h) => h.url)).toContain(lead.url)
        expect(lead.need_match.matchedTerms.length).toBeGreaterThan(0)
        // A lead never invents an application target, amount, or deadline.
        expect(lead.application_url).toBeNull()
        expect(lead.amount_min ?? null).toBeNull()
        expect(lead.amount_max ?? null).toBeNull()
        expect(lead.deadline ?? null).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  it('acceptance 2 — "help to pay for an Ethics Probe Class": curated program re-ranked to top + web leads appended; non-student individual is not blocked', async () => {
    searchWebMock.mockResolvedValue(PROBE_WEB_HITS)
    loadResultsMock.mockResolvedValue([PROBE_CURATED_RESULT])
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({
          profile_id: 'profile-owned',
          need_text: 'help to pay for an Ethics Probe Class',
          min_match_score: 15,
          max_results: 40,
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // Taxonomy routing: the free-text sentence resolves to license reinstatement.
      expect(res.body.expanded.matchedKey).toBe('probe class')
      expect(res.body.expanded.canonicalNeed).toBe('license_reinstatement_support')

      // The curated program made it through and ranks FIRST (strong profile +
      // need match beats raw web leads).
      const curated = res.body.opportunities.filter((o) => o.result_source === 'curated')
      expect(curated.length).toBe(1)
      expect(curated[0].title).toBe(PROBE_CURATED_RESULT.name)
      expect(res.body.opportunities[0].result_source).toBe('curated')
      expect(curated[0].need_match.score).toBeGreaterThanOrEqual(15)

      // The live web lead (the actual PROBE course page) is appended + labeled.
      const leads = res.body.opportunities.filter((o) => o.result_source === 'web_search')
      expect(leads.length).toBe(1)
      expect(leads[0].url).toBe(PROBE_WEB_HITS[0].url)
    } finally {
      db.close()
    }
  })

  it('overrunning live crawl returns 200 partial from persisted results — never a 504', async () => {
    // Simulate the live crawl hanging past the gateway budget.
    runLiveMock.mockImplementation(() => new Promise(() => {}))
    loadResultsMock.mockResolvedValue([PROBE_CURATED_RESULT])
    searchWebMock.mockResolvedValue([])
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned', need_text: 'ethics probe class', min_match_score: 15 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.timed_out).toBe(true)
      expect(res.body.partial).toBe(true)
      // Persisted catalog results still surface (re-ranked against the need).
      expect(res.body.opportunities.length).toBeGreaterThan(0)
      expect(loadResultsMock).toHaveBeenCalled()
    } finally {
      db.close()
    }
  }, 15000)

  it('WEB_DISCOVERY_ENABLED=false → honest web_search.attempted=false, no web calls', async () => {
    process.env.WEB_DISCOVERY_ENABLED = 'false'
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const res = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned', need_text: 'passenger van' })

      expect(res.status).toBe(200)
      expect(res.body.web_search.attempted).toBe(false)
      expect(res.body.web_search_results).toBe(0)
      expect(searchWebMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects a user with no access to the profile (403) and never searches', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'intruder', role: 'user' }, { isAdmin: false })

      const res = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned', need_text: 'passenger van' })

      expect(res.status).toBe(403)
      expect(searchWebMock).not.toHaveBeenCalled()
      expect(runLiveMock).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('rejects missing/too-short need_text (400)', async () => {
    const db = new Database(':memory:')
    try {
      seedSchema(db)
      const app = createApp(db, { userId: 'owner', role: 'user' })

      const missing = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned' })
      expect(missing.status).toBe(400)

      const short = await request(app)
        .post('/api/real-crawlers/specific-need')
        .send({ profile_id: 'profile-owned', need_text: 'x' })
      expect(short.status).toBe(400)
    } finally {
      db.close()
    }
  })
})
