import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import fundingSourcesRouter from '../routes/fundingSources.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { readFundingSourceRows } from '../services/matching/fundingSourceQueries.js'
import { loadRegressionFixture, FIXTURE_PROFILE_ID, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

vi.mock('../services/profileHelpers.js', async (original) => ({ ...await original(), loadProfileContext: vi.fn() }))
vi.mock('../services/matching/fundingSourceQueries.js', async (original) => ({ ...await original(), readFundingSourceRows: vi.fn() }))

const fixture = loadRegressionFixture()
const original = fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo)
const match = fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo)
const selected = original.apply_url || original.application_url

function appFor(row) {
  vi.mocked(loadProfileContext).mockResolvedValue({ profile: fixture.profile,
    sections: Object.fromEntries(fixture.sections.map(s => [s.section_key, s.data])) })
  vi.mocked(readFundingSourceRows).mockResolvedValue({ rows: [row], dismissal_filter: 'fixture' })
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', role: 'admin' }
    req.ctx = { userId: 'admin-1', isAdmin: true }
    req.db = {}
    next()
  })
  app.use('/api', fundingSourcesRouter)
  return app
}

describe('curated funding-source HTTP target selection', () => {
  it('retains the verified target through both route mappings without mutating score truth', async () => {
    const row = { ...original, is_active: 1, is_hidden: 0,
      match_score: match.match_score, match_decision: match.match_decision,
      match_confidence: match.match_confidence, matcher_version: match.matcher_version,
      match_explain_json: match.match_explain_json, apply_url: selected, application_url: selected }
    const get = app => request(app).get(`/api/profiles/${FIXTURE_PROFILE_ID}/funding-sources?min_score=0`)
    const baseline = await get(appFor(row))
    expect(baseline.status).toBe(200)
    expect(baseline.body.sources).toHaveLength(1)
    expect(baseline.body.sources[0].url).toBe(selected)
    const conflicting = { ...row, application_url: 'https://alpha.grantable.co/login' }
    const response = await get(appFor(conflicting))
    expect(response.status).toBe(200)
    expect(response.body.sources).toHaveLength(1)
    expect(response.body.sources[0]).toMatchObject({ url: selected, application_url: selected,
      match_score: baseline.body.sources[0].match_score, match_decision: baseline.body.sources[0].match_decision })
    expect(response.body.need_first_reconciliation.read_only).toBe(true)
    expect(conflicting.application_url).toBe('https://alpha.grantable.co/login')
  })
})
