import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fundingSourcesRouter from '../routes/fundingSources.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { loadRegressionFixture, FIXTURE_PROFILE_ID, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

vi.mock('../services/profileHelpers.js', async (original) => ({ ...await original(), loadProfileContext: vi.fn() }))

const fixture = loadRegressionFixture()
const original = fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo)
const match = fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo)
const selected = original.apply_url || original.application_url

const databases = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs() })
function sourceDb(row) {
  const db = new Database(':memory:'); databases.push(db)
  const cols = 'id title sponsor description eligibility_bullets deadline deadline_type amount_min amount_max state is_national application_url apply_url source_url source source_id record_origin opportunity_kind opportunity_type type funding_type is_loan source_trust_tier categories keywords link_status link_status_code last_verified_at verification_method is_active is_hidden updated_at'.split(' ')
  const matchCols = 'id profile_id opportunity_id match_score match_confidence match_decision match_explanation match_reasons match_explain_json matcher_version'.split(' ')
  db.exec('CREATE TABLE funding_opportunities (' + cols.join(',') + '); CREATE TABLE profile_opportunity_matches (' + matchCols.join(',') + '); CREATE TABLE pipeline_dismissals (profile_id,opportunity_id,title);')
  const bind = x => x === undefined || x === null ? null : typeof x === 'boolean' ? Number(x) : typeof x === 'object' ? JSON.stringify(x) : x
  db.prepare('INSERT INTO funding_opportunities VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map(c => bind(row[c])))
  const stored = { ...match, ...row, id: 'fixture-match', profile_id: FIXTURE_PROFILE_ID, opportunity_id: row.id }
  db.prepare('INSERT INTO profile_opportunity_matches VALUES (' + matchCols.map(() => '?').join(',') + ')').run(...matchCols.map(c => bind(stored[c])))
  return db
}

function appFor(row) {
  vi.stubEnv('SHOULDERS_VNEXT', 'false')
  const db = sourceDb(row)
  vi.mocked(loadProfileContext).mockResolvedValue({ profile: fixture.profile,
    sections: Object.fromEntries(fixture.sections.map(s => [s.section_key, s.data])) })
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', role: 'admin' }
    req.ctx = { userId: 'admin-1', isAdmin: true }
    req.db = db
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
