import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateOpportunity, deduplicateByUrl, validateBatch } from '../../backend/services/opportunityValidator.js'

describe('validateOpportunity', () => {
  const VALID_OPP = {
    title: 'Tennessee SNAP Benefits Program',
    sponsor: 'USDA Food and Nutrition Service',
    description: 'Monthly food assistance for low-income individuals.',
    url: 'https://www.fns.usda.gov/snap',
    source_url: 'https://www.fns.usda.gov/snap',
    opportunity_type: 'benefit',
  }

  it('accepts valid opportunity', () => {
    const result = validateOpportunity(VALID_OPP)
    assert.ok(result.valid, `Expected valid, got errors: ${result.errors}`)
    assert.equal(result.errors.length, 0)
  })

  it('rejects missing title', () => {
    const result = validateOpportunity({ ...VALID_OPP, title: '' })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('missing_or_short_title'))
  })

  it('rejects short title', () => {
    const result = validateOpportunity({ ...VALID_OPP, title: 'Hi' })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('missing_or_short_title'))
  })

  it('rejects missing sponsor and description', () => {
    const result = validateOpportunity({ ...VALID_OPP, sponsor: '', description: '' })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('missing_sponsor_and_description'))
  })

  it('accepts with sponsor only (no description)', () => {
    const result = validateOpportunity({ ...VALID_OPP, description: '' })
    assert.ok(result.valid)
  })

  it('rejects no valid URL', () => {
    const result = validateOpportunity({ ...VALID_OPP, url: '', source_url: '', application_url: '' })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('no_valid_url'))
  })

  it('rejects placeholder content', () => {
    const result = validateOpportunity({ ...VALID_OPP, title: 'lorem ipsum test' })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('placeholder_content'))
  })

  it('rejects loan-like opportunity', () => {
    const result = validateOpportunity({ ...VALID_OPP, is_loan: true })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('loan_like'))
  })

  it('allows loan when allowLoans=true', () => {
    const result = validateOpportunity({ ...VALID_OPP, is_loan: true }, { allowLoans: true })
    assert.ok(result.valid)
    assert.ok(result.warnings.includes('loan_opportunity_allowed'))
  })

  it('rejects matching funds', () => {
    const result = validateOpportunity({ ...VALID_OPP, requires_match: true })
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('matching_funds'))
  })

  it('infers opportunity type', () => {
    const result = validateOpportunity({ ...VALID_OPP, opportunity_type: '' })
    assert.ok(result.valid)
    assert.ok(result.opportunityType, 'Should have an inferred type')
  })

  it('infers scholarship type', () => {
    const opp = { ...VALID_OPP, title: 'Gates Scholarship Program', opportunity_type: '' }
    const result = validateOpportunity(opp)
    assert.equal(result.opportunityType, 'scholarship')
  })

  it('rejects expired deadline by default', () => {
    const opp = { ...VALID_OPP, deadline: '2020-01-01', deadline_type: 'fixed' }
    const result = validateOpportunity(opp)
    assert.ok(!result.valid, 'expired opportunity must fail validation by default')
    assert.ok(result.isExpired)
    assert.ok(result.errors.includes('deadline_passed'),
      `expected errors to include 'deadline_passed', got: ${JSON.stringify(result.errors)}`)
  })

  it('accepts expired deadline when allowExpired=true (warning only)', () => {
    const opp = { ...VALID_OPP, deadline: '2020-01-01', deadline_type: 'fixed' }
    const result = validateOpportunity(opp, { allowExpired: true })
    assert.ok(result.valid, `expected valid with allowExpired:true, got errors: ${JSON.stringify(result.errors)}`)
    assert.ok(result.isExpired)
    assert.ok(result.warnings.includes('deadline_passed'))
  })

  it('detects directory-like entry', () => {
    const opp = { ...VALID_OPP, type: 'DIRECTORY' }
    const result = validateOpportunity(opp)
    assert.ok(result.valid)
    assert.ok(result.isDirectory)
  })

  it('rejects social media URL', () => {
    const opp = { ...VALID_OPP, url: 'https://www.facebook.com/some-page', source_url: '' }
    const result = validateOpportunity(opp)
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('non_actionable_url'))
  })

  it('produces normalized URL for dedup', () => {
    const result = validateOpportunity(VALID_OPP)
    assert.ok(result.normalizedUrl)
    assert.ok(result.normalizedUrl.includes('fns.usda.gov'))
  })

  it('rejects invalid object', () => {
    const result = validateOpportunity(null)
    assert.ok(!result.valid)
    assert.ok(result.errors.includes('invalid_object'))
  })
})

describe('deduplicateByUrl', () => {
  it('removes duplicates by normalized URL', () => {
    const opps = [
      { title: 'Grant A', url: 'https://www.grants.gov/opportunity/123' },
      { title: 'Grant B', url: 'https://www.grants.gov/opportunity/123/' },
      { title: 'Grant C', url: 'https://other.gov/different' },
    ]
    const { unique, duplicateCount } = deduplicateByUrl(opps)
    assert.equal(unique.length, 2)
    assert.equal(duplicateCount, 1)
  })

  it('keeps all when no duplicates', () => {
    const opps = [
      { title: 'A', url: 'https://a.gov/1' },
      { title: 'B', url: 'https://b.gov/2' },
    ]
    const { unique, duplicateCount } = deduplicateByUrl(opps)
    assert.equal(unique.length, 2)
    assert.equal(duplicateCount, 0)
  })

  it('handles empty array', () => {
    const { unique, duplicateCount } = deduplicateByUrl([])
    assert.equal(unique.length, 0)
    assert.equal(duplicateCount, 0)
  })
})

describe('validateBatch', () => {
  const VALID_OPP = {
    title: 'Tennessee SNAP Benefits Program',
    sponsor: 'USDA',
    description: 'Food assistance',
    url: 'https://www.fns.usda.gov/snap',
    opportunity_type: 'benefit',
  }

  it('filters invalid entries and deduplicates', () => {
    const opps = [
      VALID_OPP,
      { ...VALID_OPP, url: 'https://www.fns.usda.gov/snap/' },
      { title: '', url: 'https://bad.gov' },
      { ...VALID_OPP, title: 'Other Program', url: 'https://other.gov/prog' },
    ]
    const { valid, rejected, stats } = validateBatch(opps)
    assert.equal(stats.total, 4)
    assert.ok(stats.duplicates >= 1, `Expected at least 1 duplicate, got ${stats.duplicates}`)
    assert.ok(valid.length >= 1, 'Should have at least 1 valid')
    assert.ok(rejected.length >= 1, 'Should have at least 1 rejected')
  })
})
