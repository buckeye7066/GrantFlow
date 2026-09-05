/**
 * Issue #1501, defect 5: rows that the link-proof writer has HIDDEN but left
 * ACTIVE must never leak into the comprehensive, canonical, or AI-observed
 * matching readers. Every reader below composes the centralized lifecycle
 * contract (config/matchSurfacing.js) and the shared trusted-origin read guard
 * (utils/recordOrigins.js), which now carries the same lifecycle predicate.
 *
 * The three catalog rows are deliberately near-identical so that, if a hidden
 * or inactive row DID enter a reader, it would score and surface exactly like
 * the visible one — its absence is attributable to lifecycle only.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const provider = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('../utils/openaiClient.js', () => ({
  createOpenAIClient: () => ({
    openai: {
      chat: {
        completions: { create: provider.create },
      },
    },
  }),
  summarizeOpenAIError: (error) => ({ message: error?.message || String(error) }),
}))

const aiRouter = (await import('../routes/ai.js')).default

const HIDDEN_TITLE = 'Housing Stability Fund II (writer-hidden, still active)'
const INACTIVE_TITLE = 'Housing Stability Fund III (kill-switched)'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active'
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, applicant_type TEXT, state TEXT,
      keywords TEXT DEFAULT '[]', focus_areas TEXT DEFAULT '[]', veteran INTEGER,
      disabled INTEGER, first_generation INTEGER, snap_recipient INTEGER,
      ssi_recipient INTEGER, mission TEXT, funding_amount_needed INTEGER
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      eligibility_bullets TEXT DEFAULT '[]', categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]', amount_max INTEGER, deadline TEXT,
      deadline_type TEXT, application_url TEXT, opportunity_kind TEXT,
      is_national INTEGER DEFAULT 0, state TEXT, is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0, link_status TEXT, last_verified_at TEXT,
      record_origin TEXT, source TEXT, profile_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO profiles (id, display_name) VALUES ('org-1', 'Housing Applicant');
    INSERT INTO organizations (
      id, name, applicant_type, state, keywords, focus_areas, mission, funding_amount_needed
    ) VALUES (
      'org-1', 'Housing Applicant', 'nonprofit', 'TN', '["housing"]',
      '["housing stability"]', 'Keep Tennessee families housed', 50000
    );
  `)
  const insert = db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, description, eligibility_bullets, categories, keywords,
      amount_max, application_url, opportunity_kind, is_national, is_active, is_hidden,
      link_status, last_verified_at, record_origin, source, profile_id
    ) VALUES (?, ?, 'Official Foundation', 'Funding for nonprofit housing-stability programs.',
      '["Nonprofit applicants","Housing programs"]', '["housing"]', '["housing","stability"]',
      75000, ?, 'direct', 1, ?, ?, ?, ?, 'curated_verified', 'official_test', NULL)
  `)
  const fresh = new Date().toISOString()
  insert.run('visible-1', 'Housing Stability Fund', 'https://official.example/apply', 1, 0, 'ok', fresh)
  // The write guard quarantines an unproven direct row by HIDING it while it
  // stays active for the verifier; readers must not treat "active" as visible.
  insert.run('hidden-active-1', HIDDEN_TITLE, 'https://official.example/apply-2', 1, 1, 'unverified', null)
  insert.run('inactive-1', INACTIVE_TITLE, 'https://official.example/apply-3', 0, 0, 'ok', fresh)
  return db
}

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { id: 'admin-1', userId: 'admin-1', role: 'admin' }
    req.ctx = { isAdmin: true, userId: 'admin-1' }
    next()
  })
  app.use('/api/ai', aiRouter)
  return app
}

const ids = (rows) => (rows || []).map((row) => row.id)

describe('AI matching readers never surface writer-hidden or inactive catalog rows', () => {
  let db

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => {
    provider.create.mockReset()
    db.close()
  })

  it('POST /api/ai/comprehensive-match reads only lifecycle-visible rows (total counts candidates, not storage)', async () => {
    const res = await request(makeApp(db))
      .post('/api/ai/comprehensive-match')
      .send({ profile_id: 'org-1', profile: { id: 'org-1', state: 'TN', keywords: ['housing'] } })

    expect(res.status).toBe(200)
    // `total` is the number of candidate rows that reached scoring. Storage
    // holds three rows; only one may ever be read.
    expect(res.body.total).toBe(1)
    expect(ids(res.body.opportunities)).toEqual(['visible-1'])
  })

  it('POST /api/ai/match reads only lifecycle-visible rows', async () => {
    const res = await request(makeApp(db))
      .post('/api/ai/match')
      .send({ profile_id: 'org-1', limit: 10 })

    expect(res.status).toBe(200)
    const returned = ids(res.body.opportunities)
    expect(returned).toContain('visible-1')
    expect(returned).not.toContain('hidden-active-1')
    expect(returned).not.toContain('inactive-1')
  })

  it('POST /api/ai/match/ai drops hidden ids from an explicit id list BEFORE the model sees them', async () => {
    provider.create.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            observations: [
              { id: 'visible-1', notes: ['visible'] },
              { id: 'hidden-active-1', notes: ['should never be asked about'] },
              { id: 'inactive-1', notes: ['should never be asked about'] },
            ],
          }),
        },
      }],
    })

    const res = await request(makeApp(db))
      .post('/api/ai/match/ai')
      .send({ profile_id: 'org-1', opportunity_ids: ['visible-1', 'hidden-active-1', 'inactive-1'], limit: 10 })

    expect(res.status).toBe(200)
    expect(ids(res.body.opportunities)).toEqual(['visible-1'])

    // The quarantine must hold at the READ, not merely at the response: the
    // provider prompt is built from the rows the reader returned.
    expect(provider.create).toHaveBeenCalledTimes(1)
    const prompt = provider.create.mock.calls[0][0].messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('Housing Stability Fund')
    expect(prompt).not.toContain(HIDDEN_TITLE)
    expect(prompt).not.toContain(INACTIVE_TITLE)
  })
})
