/** Regressions for software/editorial URLs falsely presented as funder applications. */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { computeMatchDecision } from '../services/matchEngine.js'
import { classifyNonApplicationSurface } from '../config/applicationSurfaceHosts.js'
import { classifyApplyability } from '../config/sourceApplyability.js'
import { extractOpportunitiesFromPage } from '../services/webGrantExtractor.js'
import { saveToProfilePipeline } from '../services/opportunityMatcher.js'

const VENDOR = 'https://alpha.grantable.co/login?ref=apply&seed=grant%3Afixture&id=fixture'
const REAL = 'https://fixture-foundation.org/apply'
const PROFILE = { id: 'p1', primary_type: 'individual', state: 'OH', needs: ['housing', 'utilities'] }
const BASE = {
  id: 'fixture-opportunity', title: 'Ohio Housing and Utility Assistance',
  description: 'For Ohio residents facing eviction or utility shutoff.',
  eligibility_text: 'For Ohio residents facing eviction or utility shutoff.',
  sponsor: 'Fixture Housing Foundation', source: 'web_search', record_origin: 'live_crawl',
  is_national: false, state: 'OH', entity_types_allowed: ['individual'],
  categories: ['housing', 'utilities'], keywords: ['rent', 'utilities', 'eviction'],
  need_types_supported: ['housing', 'utilities'], is_loan: false,
}
function pipelineDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT);
    INSERT INTO profiles VALUES ('p1', 'org1');
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE exclusion_rules (id TEXT PRIMARY KEY, action TEXT);
    CREATE TABLE grants (id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT, profile_id TEXT, funding_opportunity_id TEXT, title TEXT NOT NULL,
      funder TEXT, status TEXT DEFAULT 'discovered', deadline TEXT, match_score INTEGER,
      match_reasons TEXT, notes TEXT, application_url TEXT, application_method TEXT,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT, amount_requested TEXT,
      amount_min TEXT, amount_max TEXT, url TEXT, fingerprint TEXT, fingerprint_version INTEGER);`)
  return db
}
describe('non-application targets at the canonical admission boundary', () => {
  it('the control is actually ACCEPT, not an unrelated refusal', () => {
    expect(computeMatchDecision(PROFILE, { ...BASE, application_url: REAL }).decision).toBe('ACCEPT')
  })
  it.each([VENDOR, 'https://grantable.co/funders/fixture', 'https://app.grantable.co/login'])('recognizes the verified software vendor: %s', (url) => {
    expect(classifyNonApplicationSurface(url)?.reason).toBe('non_application_vendor_content')
    expect(classifyApplyability({ ...BASE, application_url: url }).isApplyable).toBe(false)
  })
  it.each(['application_url', 'apply_url', 'url'])('holds a vendor target in %s at REVIEW without changing its score', (field) => {
    const row = { ...BASE, [field]: VENDOR }
    const result = computeMatchDecision(PROFILE, row)
    expect(result.decision).toBe('REVIEW')
    expect(result.eligible).toBe('maybe')
    expect(result.match_explain.application_target).toMatchObject({ status: 'non_application', reason: 'non_application_vendor_content' })
    expect(result.explanation).toMatch(/application/i)
    expect(row[field]).toBe(VENDOR)
    expect(result.score).toBe(computeMatchDecision(PROFILE, { ...BASE, [field]: REAL }).score)
  })
  it.each(['https://en.wikipedia.org/wiki/Housing', 'https://fixture-foundation.org/blog/grant-guide'])('reuses the existing non-application authority: %s', (url) => {
    expect(computeMatchDecision(PROFILE, { ...BASE, application_url: url }).decision).toBe('REVIEW')
  })
  it.each([REAL, 'https://fixture.submittable.com/submit/123', 'https://fixture.smapply.io/prog/award', 'https://notgrantable.co/apply'])('preserves real or unknown portals and exact host boundaries: %s', (url) => {
    expect(classifyNonApplicationSurface(url)).toBeNull()
    expect(computeMatchDecision(PROFILE, { ...BASE, application_url: url }).decision).toBe('ACCEPT')
  })
  it('a vendor discovery source does not taint a separate real application URL', () => {
    expect(computeMatchDecision(PROFILE, { ...BASE, source_url: VENDOR, application_url: REAL }).decision).toBe('ACCEPT')
  })
  it('never promotes an existing hard rejection to review', () => {
    expect(computeMatchDecision({ ...PROFILE, state: 'TN' }, { ...BASE, application_url: VENDOR }).decision).toBe('REJECT')
  })
  it('the real pipeline writer refuses the vendor link but persists the valid control', async () => {
    const db = pipelineDb()
    try {
      const context = { profile: PROFILE, sections: {} }
      const denied = await saveToProfilePipeline(db, { ...BASE, application_url: VENDOR }, PROFILE.id, context)
      expect(denied).toMatchObject({ saved: false, gate: 'DECISION_ENGINE', decision: 'REVIEW' })
      expect(db.prepare('SELECT count(*) AS n FROM grants').get().n).toBe(0)
      const admitted = await saveToProfilePipeline(db, { ...BASE, application_url: REAL }, PROFILE.id, context)
      expect(admitted.saved, JSON.stringify(admitted)).toBe(true)
      expect(db.prepare('SELECT application_url FROM grants').get().application_url).toBe(REAL)
    } finally { db.close() }
  })
})
describe('live extraction retains the source without a false apply target', () => {
  it.each([VENDOR, REAL])('a selected on-page link is checked for application authority: %s', async (url) => {
    const pageUrl = 'https://fixture-foundation.org/award'
    const html = '<main><h1>Fixture Housing Grant</h1><p>Fixture Housing Foundation offers housing grants to Ohio residents facing eviction or utility shutoff. Applicants can read the eligibility conditions on this page. This fixture contains enough source text to exercise the real extractor without calling any network provider.</p><a href="' + url + '">Apply now</a></main>'
    const invoke = async () => ({ ok: true, json: { opportunities: [{
      title: 'Fixture Housing Grant', funder: 'Fixture Housing Foundation',
      summary: 'Housing grants to Ohio residents facing eviction or utility shutoff.',
      eligibility_text: 'Ohio residents facing eviction or utility shutoff', eligibility_bullets: [],
      need_categories: ['housing'], amount_min: null, amount_max: null, deadline: null,
      national: false, states: ['OH'], is_loan: null, requires_cost_share: null,
      apply_link_id: 'L1', info_link_id: null,
      evidence: { eligibility: 'Ohio residents facing eviction or utility shutoff', geography: 'Ohio residents' },
    }] } })
    const out = await extractOpportunitiesFromPage({ pageUrl, html }, { invoke, openai: null })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Fixture Housing Grant')
    if (url === VENDOR) {
      expect(out[0].apply_url).toBeNull()
      expect(out[0].info_url).toBe(pageUrl)
      expect(out[0].raw.application_target_refusal).toMatchObject({ reason: 'non_application_vendor_content', url: VENDOR })
    } else { expect(out[0].apply_url).toBe(REAL) }
  })
})

// Review regression: two aliases can coexist after a catalog update.
import { toCanonicalResult } from '../../src/components/funding/toCanonicalResult.js'
import { resolveApplicationUrl } from '../../shared/applicationTarget.js'
import { classifyFundingSource } from '../services/hamilton/hamiltonAutomationClassifier.js'
it.each([
  { apply_url: REAL, application_url: VENDOR, expected: 'ACCEPT' },
  { apply_url: VENDOR, application_url: REAL, expected: 'REVIEW' },
])('engine, actionability, card and writer agree on apply_url: $expected', async ({ apply_url, application_url, expected }) => {
  const row = { ...BASE, apply_url, application_url }
  expect(computeMatchDecision(PROFILE, row).decision).toBe(expected)
  expect(toCanonicalResult(row).application_url).toBe(apply_url)
  expect(classifyFundingSource({ opportunity: row }).resolved_url).toBe(apply_url)
  expect(resolveApplicationUrl(row)).toBe(apply_url)
  expect(classifyApplyability(row).isApplyable).toBe(expected === 'ACCEPT')
  const db = pipelineDb()
  try {
    const result = await saveToProfilePipeline(db, row, PROFILE.id, { profile: PROFILE, sections: {} })
    expect(result.saved).toBe(expected === 'ACCEPT')
    if (result.saved) expect(db.prepare('SELECT application_url FROM grants').get().application_url).toBe(apply_url)
    else expect(db.prepare('SELECT count(*) AS n FROM grants').get().n).toBe(0)
  } finally { db.close() }
})
it('an explicit application target outranks a legacy reference URL at every application consumer', async () => {
  const row = { ...BASE, application_url: REAL, url: VENDOR }
  expect(computeMatchDecision(PROFILE, row).decision).toBe('ACCEPT')
  expect(resolveApplicationUrl(row)).toBe(REAL)
  const db = pipelineDb()
  try {
    const result = await saveToProfilePipeline(db, row, PROFILE.id, { profile: PROFILE, sections: {} })
    expect(result.saved).toBe(true)
    expect(db.prepare('SELECT application_url FROM grants').get().application_url).toBe(REAL)
  } finally { db.close() }
})

it.each([
  { selected: 'https://www.hud.gov/grants', stale: VENDOR },
  { selected: VENDOR, stale: 'https://www.hud.gov/grants' },
])('confidence is based on the selected application target, not a stale alias: $selected', ({ selected, stale }) => {
  const single = computeMatchDecision(PROFILE, { ...BASE, apply_url: selected })
  const conflicting = computeMatchDecision(PROFILE, { ...BASE, apply_url: selected, application_url: stale })
  expect(conflicting.confidence).toBe(single.confidence)
  expect(conflicting.match_explain.confidence).toBe(single.match_explain.confidence)
  expect(conflicting.decision).toBe(single.decision)
})
