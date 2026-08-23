/**
 * robertFunderLeads.test.js — Robert's national-funder pipeline flow.
 *
 * Covers, mutation-mindfully (each rule has a MUST-add and a MUST-NOT-add case):
 *   - the FUNDER_LEAD vs APPLY_READY separation + Hamilton's auto-submit exclusion
 *   - national-footprint admission (>= 5 states) alongside in-state givers
 *   - the recipient-type gate (a foundation that gives org-to-org is not offered
 *     to an individual unless its filings name a PERSON recipient)
 *   - the four-gate qualification bypasses the ratio-score floor
 *   - idempotency, per-profile cap, count-only
 *   - active investigation -> PROMOTION to apply-ready on a real application path
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  admitFunderLeads, investigateFunderLeads, promoteFunderLeadIfApplicable,
  qualifyFunderLead, looksLikeApplicationPath,
} = await import('../services/robert/robertFunderLeads.js')
const { analyzeFunderFit, NATIONAL_FOOTPRINT_MIN_STATES } = await import('../config/funderBehavior.js')
const { isFunderLead, isApplyReady, hasUsableApplyPath, PIPELINE_CATEGORY, FUNDER_LEAD_STATE } =
  await import('../config/pipelineCategory.js')

const SCHEMA = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, organization_id TEXT,
  status TEXT, deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE profile_sections (
  profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
  PRIMARY KEY (profile_id, section_key)
);
CREATE TABLE funding_opportunities (
  id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, source TEXT, source_id TEXT,
  source_url TEXT, application_url TEXT, apply_url TEXT, opportunity_kind TEXT,
  entity_types_allowed TEXT, need_types_supported TEXT, categories TEXT,
  eligibility_text TEXT, eligibility_bullets TEXT, state TEXT, is_national INTEGER,
  is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY, organization_id TEXT, profile_id TEXT, funding_opportunity_id TEXT,
  title TEXT, funder TEXT, status TEXT DEFAULT 'discovered', notes TEXT,
  application_url TEXT, portal_url TEXT, url TEXT, source_url TEXT,
  match_score INTEGER, match_decision TEXT, matcher_version TEXT,
  pipeline_category TEXT, funder_lead_state TEXT, funder_lead_attempts INTEGER DEFAULT 0,
  funder_lead_last_investigated_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE grant_transactions (
  id TEXT PRIMARY KEY, funder_ein TEXT, recipient_name TEXT, recipient_is_individual INTEGER DEFAULT 0,
  recipient_ein TEXT, recipient_city TEXT, recipient_state TEXT, recipient_country TEXT,
  amount NUMERIC, purpose TEXT
);
`

let db
let txSeq = 0

function seedProfile(id, { type = 'nonprofit', state = 'TN', needs = ['housing'] } = {}) {
  db.raw.prepare('INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?,?,?,?)')
    .run(id, `Profile ${id}`, type, 'active')
  db.raw.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?,?,?,?)')
    .run(id, 'basic_information', JSON.stringify({ state, profile_category: type }), 't')
  db.raw.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?,?,?,?)')
    .run(id, 'location_focus', JSON.stringify({ state }), 't')
  db.raw.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?,?,?,?)')
    .run(id, 'financial_information', JSON.stringify({ needs }), 't')
}

function seedFunder(id, ein, { name = 'Test Foundation', kind = 'directory' } = {}) {
  db.raw.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, opportunity_kind, is_active)
     VALUES (?,?,?,?,?,?,?,1)`,
  ).run(id, name, name, 'propublica_990', ein, `https://projects.propublica.org/nonprofits/organizations/${ein}`, kind)
}

function seedTx(ein, state, { individual = false, amount = 50000, purpose = 'emergency rental assistance for homeless families' } = {}) {
  db.raw.prepare(
    `INSERT INTO grant_transactions (id, funder_ein, recipient_name, recipient_is_individual, recipient_state, amount, purpose)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(`tx${txSeq++}`, ein, individual ? 'Jane Doe' : 'Some Org', individual ? 1 : 0, state, amount, purpose)
}

function grantsFor(profileId) {
  return db.raw.prepare('SELECT * FROM grants WHERE profile_id = ?').all(profileId)
}

beforeEach(() => {
  db = wrapSqlite(new Database(':memory:'))
  db.raw.exec(SCHEMA)
  txSeq = 0
})

describe('pipelineCategory predicates', () => {
  it('funder_lead is a lead; NULL/apply_ready is apply-ready', () => {
    expect(isFunderLead({ pipeline_category: 'funder_lead' })).toBe(true)
    expect(isFunderLead({ pipeline_category: 'FUNDER_LEAD' })).toBe(true)
    expect(isFunderLead({ pipeline_category: null })).toBe(false)
    expect(isApplyReady({ pipeline_category: null })).toBe(true)
    expect(isApplyReady({ pipeline_category: 'apply_ready' })).toBe(true)
    expect(isApplyReady({ pipeline_category: 'funder_lead' })).toBe(false)
  })
  it('hasUsableApplyPath requires a real http(s) non-search URL', () => {
    expect(hasUsableApplyPath({ application_url: 'https://foundation.org/apply' })).toBe(true)
    expect(hasUsableApplyPath({ portal_url: 'https://x.org' })).toBe(true)
    expect(hasUsableApplyPath({ url: 'https://www.google.com/search?q=grant' })).toBe(false)
    expect(hasUsableApplyPath({ application_url: null, url: '' })).toBe(false)
  })
})

describe('analyzeFunderFit', () => {
  it('counts distinct states + national footprint + recipient-type', () => {
    const txs = [
      { recipient_state: 'CA', amount: 1, purpose: 'rental assistance', recipient_is_individual: 0 },
      { recipient_state: 'NY', amount: 2, purpose: 'homeless shelter', recipient_is_individual: 0 },
      { recipient_state: 'TX', amount: 9, purpose: 'eviction prevention', recipient_is_individual: 1 },
      { recipient_state: 'FL', amount: 3, purpose: 'housing', recipient_is_individual: 0 },
      { recipient_state: 'WA', amount: 4, purpose: 'rent assistance', recipient_is_individual: 0 },
      { recipient_state: 'CA', amount: 5, purpose: 'unrelated dental grant', recipient_is_individual: 0 },
    ]
    const fit = analyzeFunderFit(txs, new Set(['housing']), { profileState: 'TN' })
    expect(fit.evidencingCount).toBe(5) // the dental grant does not evidence housing
    expect(fit.distinctStates).toBe(5)
    expect(fit.nationalFootprint).toBe(true)
    expect(fit.inState).toBe(false)
    expect(fit.fundsIndividuals).toBe(true)
    expect(fit.topAmount).toBe(9) // largest AMONG evidencing grants (the $5 CA dental is not housing)
  })
  it('a single out-of-state grant is NOT a national footprint', () => {
    const fit = analyzeFunderFit(
      [{ recipient_state: 'CA', amount: 1, purpose: 'rental assistance' }], new Set(['housing']), { profileState: 'TN' })
    expect(fit.distinctStates).toBe(1)
    expect(fit.nationalFootprint).toBe(false)
    expect(fit.inState).toBe(false)
  })
})

describe('admitFunderLeads — admission gates', () => {
  it('adds a NATIONAL-footprint funder as a FUNDER_LEAD (never apply-ready)', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    seedFunder('f1', '111111111', { name: 'National Housing Fund' })
    for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx('111111111', st)

    const res = await admitFunderLeads(db)
    expect(res.added).toBe(1)
    const rows = grantsFor('p1')
    expect(rows).toHaveLength(1)
    expect(rows[0].pipeline_category).toBe(PIPELINE_CATEGORY.FUNDER_LEAD)
    expect(rows[0].funder_lead_state).toBe(FUNDER_LEAD_STATE.CANDIDATE)
    expect(rows[0].status).toBe('interested') // a research stage, NOT ready_to_submit
    expect(isApplyReady(rows[0])).toBe(false)
  })

  it('adds an IN-STATE funder even without a national footprint', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    seedFunder('f1', '222222222', { name: 'TN Housing Fund' })
    seedTx('222222222', 'TN')
    seedTx('222222222', 'TN', { amount: 20000 })
    const res = await admitFunderLeads(db)
    expect(res.added).toBe(1)
  })

  it('does NOT add a geographically restricted funder (1 out-of-state grant)', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    seedFunder('f1', '333333333')
    seedTx('333333333', 'CA')
    const res = await admitFunderLeads(db)
    expect(res.added).toBe(0)
    expect(res.byReason['qualifies:not_reachable_footprint']).toBeGreaterThan(0)
    expect(grantsFor('p1')).toHaveLength(0)
  })

  it('does NOT add an org-to-org foundation to an INDIVIDUAL profile (recipient-type gate)', async () => {
    seedProfile('p1', { type: 'individual', state: 'TN' })
    seedFunder('f1', '444444444')
    for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx('444444444', st, { individual: false })
    const res = await admitFunderLeads(db)
    expect(res.added).toBe(0)
    expect(res.byReason['qualifies:foundation_funds_orgs_not_individuals']).toBeGreaterThan(0)
  })

  it('DOES add a funder that funds INDIVIDUALS to an individual profile', async () => {
    seedProfile('p1', { type: 'individual', state: 'TN' })
    seedFunder('f1', '555555555')
    for (const st of ['CA', 'NY', 'TX', 'FL']) seedTx('555555555', st, { individual: false })
    seedTx('555555555', 'WA', { individual: true }) // one PERSON recipient
    const res = await admitFunderLeads(db)
    expect(res.added).toBe(1)
  })

  it('does NOT add a funder whose giving does not evidence the declared need', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN', needs: ['housing'] })
    seedFunder('f1', '666666666')
    for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx('666666666', st, { purpose: 'dental clinic equipment' })
    const res = await admitFunderLeads(db)
    expect(res.added).toBe(0)
  })

  it('is idempotent — a second pass adds nothing', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    seedFunder('f1', '111111111')
    for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx('111111111', st)
    expect((await admitFunderLeads(db)).added).toBe(1)
    expect((await admitFunderLeads(db)).added).toBe(0)
    expect(grantsFor('p1')).toHaveLength(1)
  })

  it('respects the per-profile cap', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    for (const [i, ein] of ['777777771', '777777772'].entries()) {
      seedFunder(`f${i}`, ein, { name: `Fund ${i}` })
      for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx(ein, st)
    }
    const res = await admitFunderLeads(db, { perProfileCap: 1 })
    expect(res.added).toBe(1)
    expect(res.perProfileCapped).toBeGreaterThan(0)
  })

  it('count-only mode adds nothing but reports would-add', async () => {
    seedProfile('p1', { type: 'nonprofit', state: 'TN' })
    seedFunder('f1', '111111111')
    for (const st of ['CA', 'NY', 'TX', 'FL', 'WA']) seedTx('111111111', st)
    const res = await admitFunderLeads(db, { countOnly: true })
    expect(res.added).toBe(0)
    expect(res.wouldAdd).toBe(1)
    expect(grantsFor('p1')).toHaveLength(0)
  })
})

describe('investigation + promotion', () => {
  it('promoteFunderLeadIfApplicable promotes a lead that has an apply path', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, status, pipeline_category, funder_lead_state, application_url)
       VALUES ('g1','p1','F','interested','funder_lead','candidate','https://foundation.org/apply')`,
    ).run()
    const row = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('g1')
    expect(await promoteFunderLeadIfApplicable(db, row)).toBe(true)
    const after = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('g1')
    expect(after.pipeline_category).toBe(PIPELINE_CATEGORY.APPLY_READY)
    expect(after.funder_lead_state).toBe(FUNDER_LEAD_STATE.PROMOTED)
    expect(after.status).toBe('saved')
  })

  it('a lead with no apply path is NOT promoted', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, status, pipeline_category, funder_lead_state)
       VALUES ('g1','p1','F','interested','funder_lead','candidate')`,
    ).run()
    const row = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('g1')
    expect(await promoteFunderLeadIfApplicable(db, row)).toBe(false)
    expect(db.raw.prepare('SELECT pipeline_category FROM grants WHERE id=?').get('g1').pipeline_category).toBe('funder_lead')
  })

  it('investigation PROMOTES when a real application PATH is discovered', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, status, pipeline_category, funder_lead_state)
       VALUES ('g1','p1','National Housing Fund','National Housing Fund','interested','funder_lead','candidate')`,
    ).run()
    const findUrl = async () => ({ url: 'https://nhf.org/grants/apply', searched: true, hits: 3 })
    const res = await investigateFunderLeads(db, { findUrl })
    expect(res.promoted).toBe(1)
    const after = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('g1')
    expect(after.pipeline_category).toBe(PIPELINE_CATEGORY.APPLY_READY)
    expect(after.application_url).toBe('https://nhf.org/grants/apply')
  })

  it('a bare homepage keeps the row a lead and counts an attempt', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, status, pipeline_category, funder_lead_state, funder_lead_attempts)
       VALUES ('g1','p1','F','F Foundation','interested','funder_lead','candidate',0)`,
    ).run()
    const findUrl = async () => ({ url: 'https://ffoundation.org', searched: true, hits: 2 })
    const res = await investigateFunderLeads(db, { findUrl })
    expect(res.promoted).toBe(0)
    const after = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('g1')
    expect(after.pipeline_category).toBe('funder_lead')
    expect(after.funder_lead_attempts).toBe(1)
    expect(after.funder_lead_state).toBe(FUNDER_LEAD_STATE.INVESTIGATED)
  })

  it('a search-provider outage (0 hits) never burns an attempt', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, status, pipeline_category, funder_lead_state, funder_lead_attempts)
       VALUES ('g1','p1','F','F Foundation','interested','funder_lead','candidate',0)`,
    ).run()
    const findUrl = async () => ({ url: null, searched: true, hits: 0 })
    const res = await investigateFunderLeads(db, { findUrl })
    expect(res.deferredOutage).toBe(1)
    expect(db.raw.prepare('SELECT funder_lead_attempts FROM grants WHERE id=?').get('g1').funder_lead_attempts).toBe(0)
  })

  it('bounded attempts eventually mark the lead not_applicable', async () => {
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, status, pipeline_category, funder_lead_state, funder_lead_attempts)
       VALUES ('g1','p1','F','F Foundation','interested','funder_lead','investigated',2)`,
    ).run()
    const findUrl = async () => ({ url: 'https://ffoundation.org', searched: true, hits: 1 })
    const res = await investigateFunderLeads(db, { findUrl })
    expect(res.notApplicable).toBe(1)
    expect(db.raw.prepare('SELECT funder_lead_state FROM grants WHERE id=?').get('g1').funder_lead_state)
      .toBe(FUNDER_LEAD_STATE.NOT_APPLICABLE)
  })

  it('looksLikeApplicationPath distinguishes an apply path from a homepage', () => {
    expect(looksLikeApplicationPath('https://x.org/grants/apply')).toBe(true)
    expect(looksLikeApplicationPath('https://x.org/how-to-apply')).toBe(true)
    expect(looksLikeApplicationPath('https://x.org')).toBe(false)
    expect(looksLikeApplicationPath('https://x.org/about')).toBe(false)
  })
})

describe('Hamilton auto-submit NEVER selects a funder lead', () => {
  it('listReadySources excludes funder_lead rows, includes apply-ready', async () => {
    const { listReadySources } = await import('../routes/hamiltonAutomation.js')
    seedProfile('p1')
    db.raw.prepare(`INSERT INTO grants (id, profile_id, title, status, pipeline_category) VALUES ('a','p1','Scholarship','saved','apply_ready')`).run()
    db.raw.prepare(`INSERT INTO grants (id, profile_id, title, status, pipeline_category) VALUES ('b','p1','Legacy','saved',NULL)`).run()
    db.raw.prepare(`INSERT INTO grants (id, profile_id, title, status, pipeline_category) VALUES ('c','p1','Foundation Lead','interested','funder_lead')`).run()
    const ready = await listReadySources(db, 'p1')
    const ids = ready.map((r) => r.grant_id).sort()
    expect(ids).toEqual(['a', 'b'])
    expect(ids).not.toContain('c')
  })

  it('a funder lead becomes selectable ONLY after promotion to apply-ready', async () => {
    const { listReadySources } = await import('../routes/hamiltonAutomation.js')
    seedProfile('p1')
    db.raw.prepare(
      `INSERT INTO grants (id, profile_id, title, status, pipeline_category, funder_lead_state, application_url)
       VALUES ('c','p1','Foundation','interested','funder_lead','candidate','https://f.org/apply')`,
    ).run()
    expect(await listReadySources(db, 'p1')).toHaveLength(0)
    const row = db.raw.prepare('SELECT * FROM grants WHERE id=?').get('c')
    await promoteFunderLeadIfApplicable(db, row)
    const ready = await listReadySources(db, 'p1')
    expect(ready.map((r) => r.grant_id)).toEqual(['c'])
  })
})

describe('NATIONAL_FOOTPRINT_MIN_STATES is the measured, bounded threshold', () => {
  it('is 5', () => { expect(NATIONAL_FOOTPRINT_MIN_STATES).toBe(5) })
})
