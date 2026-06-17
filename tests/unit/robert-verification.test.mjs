import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { verifyOpportunity } from '../../backend/services/robert/robertVerification.js'

const VALID_OPP = {
  title: 'Real Fire Department Equipment Grant',
  sponsor: 'FEMA',
  description: 'Direct grant for protective equipment and training. The applicant retains all funding awarded.',
  application_url: 'https://www.fema.gov/grants/preparedness/firefighters/apply',
  source_url: 'https://www.fema.gov/grants/preparedness/firefighters',
  deadline: '2099-09-01',
  deadline_type: 'fixed',
  amount_min: 5000,
  amount_max: 100000,
  categories: ['equipment'],
  eligibility_bullets: ['Volunteer fire departments are eligible.'],
  state: 'TN',
  is_national: false,
  source: 'robert',
  record_origin: 'discovered',
}

describe('robertVerification — pre-flight rejects junk before canonical gates', () => {
  it('rejects a placeholder URL', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, application_url: 'https://example.com/x', source_url: null } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'placeholder_url')
    assert.equal(r.stage, 'preflight')
  })

  it('rejects a search-engine URL as a direct opportunity', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, application_url: 'https://www.google.com/search?q=grant', source_url: null } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'search_engine_url_for_direct_opp')
  })

  it('rejects loans', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, title: 'SBA Microloan', description: 'Repayable loan with interest.' } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'loan_like')
  })

  it('rejects matching-fund programs', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, description: 'Program requires a 50% match from the applicant.' } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'matching_funds')
  })

  it('rejects expired fixed deadlines', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, deadline: '2020-01-01', deadline_type: 'fixed' } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'expired_deadline')
  })

  it('rejects missing title', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, title: '' } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'missing_title')
  })

  it('rejects missing sponsor', async () => {
    const r = await verifyOpportunity({ opportunity: { ...VALID_OPP, sponsor: '' } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'missing_sponsor')
  })

  it('passes a valid opportunity through preflight + canonical chain', async () => {
    const r = await verifyOpportunity({ opportunity: VALID_OPP })
    assert.equal(r.ok, true, `expected ok, got reason=${r.reason} stage=${r.stage}`)
  })

  it('does NOT call live link verification when allowLiveWeb is false', async () => {
    let called = false
    const checkUrl = async () => { called = true; return { status: 'broken', code: 404, error: null } }
    const r = await verifyOpportunity({ opportunity: VALID_OPP, checkUrl, config: { allowLiveWeb: false, requireRealApplicationUrl: true } })
    assert.equal(called, false, 'checkUrl should not be invoked with live web disabled')
    assert.equal(r.ok, true)
  })

  it('marks dead links as rejected when live link verification IS enabled', async () => {
    const checkUrl = async () => ({ status: 'broken', code: 404, error: 'not found' })
    const r = await verifyOpportunity({
      opportunity: VALID_OPP,
      checkUrl,
      config: { allowLiveWeb: true, requireRealApplicationUrl: true, timeoutMs: 5000 },
    })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'dead_link')
    assert.equal(r.stage, 'link_verify')
  })
})
