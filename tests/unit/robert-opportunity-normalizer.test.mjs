import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../../backend/services/robert/robertOpportunityExtractor.js'
import { normalizeForCanonicalInsert, ROBERT_RECORD_ORIGIN } from '../../backend/services/robert/robertOpportunityNormalizer.js'

describe('robertOpportunityExtractor', () => {
  it('extracts a Grants.gov-style record', () => {
    const records = [{
      title: 'Assistance to Firefighters Grant',
      agency: 'FEMA',
      description: 'Equipment and training grants for fire departments.',
      application_url: 'https://www.fema.gov/grants/preparedness/firefighters/apply',
      source_url: 'https://www.fema.gov/grants/preparedness/firefighters',
      close_date: '2099-09-01',
      award_ceiling: 100000,
      eligibility: ['volunteer fire departments', 'career fire departments'],
    }]
    const { candidates, dropped } = extractCandidates({ records, extractionMethod: 'grants_gov_api' })
    assert.equal(candidates.length, 1)
    assert.equal(dropped, 0)
    assert.equal(candidates[0].title, 'Assistance to Firefighters Grant')
    assert.equal(candidates[0].sponsor, 'FEMA')
    assert.equal(candidates[0].confidence > 0.5, true)
  })

  it('drops placeholder URL records', () => {
    const records = [{ title: 'Test grant', sponsor: 'Test', application_url: 'https://example.com/grant' }]
    const { candidates, dropped, reasons } = extractCandidates({ records })
    assert.equal(candidates.length, 0)
    assert.equal(dropped, 1)
    assert.ok(reasons.includes('placeholder_url'))
  })

  it('drops search-engine URLs', () => {
    const records = [{ title: 'something', sponsor: 's', application_url: 'https://www.google.com/search?q=grant' }]
    const { candidates, dropped, reasons } = extractCandidates({ records })
    assert.equal(candidates.length, 0)
    assert.equal(dropped, 1)
    assert.ok(reasons.includes('search_engine_url'))
  })
})

describe('robertOpportunityNormalizer', () => {
  it('produces a canonical-insert shape with record_origin=discovered', () => {
    const candidate = {
      title: 'Firefighter Grant',
      sponsor: 'FEMA',
      description: 'Training grants for fire departments',
      application_url: 'https://www.fema.gov/apply',
      source_url: 'https://www.fema.gov/grants',
      deadline: '2099-09-01',
      deadline_type: 'fixed',
      amount_max: 50000,
      categories: ['equipment'],
      eligibility: ['volunteer fire department'],
      applicant_types: ['volunteer_fire_department'],
      need_categories: ['equipment'],
      geography: { state: 'TN', is_national: false },
    }
    const norm = normalizeForCanonicalInsert(candidate)
    assert.equal(norm.record_origin, 'discovered')
    assert.equal(ROBERT_RECORD_ORIGIN, 'discovered')
    assert.equal(norm.title, 'Firefighter Grant')
    assert.equal(norm.application_url, 'https://www.fema.gov/apply')
    assert.equal(norm.source, 'robert')
    assert.equal(norm.is_national, false)
    assert.equal(norm.state, 'TN')
  })

  it('returns null on falsy candidate', () => {
    assert.equal(normalizeForCanonicalInsert(null), null)
  })

  it('strips empty fields', () => {
    const norm = normalizeForCanonicalInsert({
      title: 'X', sponsor: 'Y', application_url: 'https://www.example.gov/x', amount_min: '', amount_description: '',
    })
    assert.ok(!('amount_min' in norm))
    assert.ok(!('amount_description' in norm))
  })
})
