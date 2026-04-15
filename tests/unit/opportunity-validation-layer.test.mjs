import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateUrlFormat,
  validateRequiredFields,
  checkDuplicate,
  validateOpportunityStrict,
} from '../../backend/services/opportunityValidationLayer.js'

// ═══════════════════════════════════════════════════════════════════════════════
// URL Validation
// ═══════════════════════════════════════════════════════════════════════════════

test('validateUrlFormat: accepts valid https URL', () => {
  const result = validateUrlFormat('https://www.grants.gov/search')
  assert.equal(result.valid, true)
})

test('validateUrlFormat: accepts valid http URL', () => {
  const result = validateUrlFormat('http://grants.ohio.gov/programs')
  assert.equal(result.valid, true)
})

test('validateUrlFormat: rejects null/undefined/empty', () => {
  assert.equal(validateUrlFormat(null).valid, false)
  assert.equal(validateUrlFormat(undefined).valid, false)
  assert.equal(validateUrlFormat('').valid, false)
  assert.equal(validateUrlFormat('   ').valid, false)
})

test('validateUrlFormat: rejects non-http protocols', () => {
  assert.equal(validateUrlFormat('ftp://files.example.com').valid, false)
  assert.equal(validateUrlFormat('javascript:alert(1)').valid, false)
  assert.equal(validateUrlFormat('data:text/html,hello').valid, false)
  assert.equal(validateUrlFormat('file:///etc/passwd').valid, false)
})

test('validateUrlFormat: rejects placeholder domains', () => {
  const placeholders = [
    'https://example.com/grants',
    'https://example.org/funding',
    'https://example.gov/programs',
    'https://example.net/aid',
    'https://placeholder.com/test',
    'https://localhost:3000/api',
    'https://127.0.0.1/api',
    'https://0.0.0.0/api',
  ]
  for (const url of placeholders) {
    const result = validateUrlFormat(url)
    assert.equal(result.valid, false, `Should reject placeholder URL: ${url} (reason: ${result.reason})`)
  }
})

test('validateUrlFormat: rejects social media URLs', () => {
  const socialUrls = [
    'https://www.facebook.com/grants',
    'https://twitter.com/sba',
    'https://www.instagram.com/grantflow',
    'https://reddit.com/r/grants',
    'https://medium.com/@grantwriter/tips',
  ]
  for (const url of socialUrls) {
    const result = validateUrlFormat(url)
    assert.equal(result.valid, false, `Should reject social media URL: ${url}`)
    assert.equal(result.reason, 'social_media_url')
  }
})

test('validateUrlFormat: wikipedia.org is caught by content filter, not URL validator', () => {
  // Wikipedia uses .org TLD which is legitimate for many funding sources.
  // The content filter (isJunkOpportunity) handles informational pages.
  const result = validateUrlFormat('https://en.wikipedia.org/wiki/Grant')
  assert.equal(result.valid, true, 'Wikipedia passes URL format check — caught at content filter level')
})

test('validateUrlFormat: accepts legitimate .gov URLs', () => {
  const govUrls = [
    'https://www.grants.gov/search-results-detail/12345',
    'https://studentaid.gov/understand-aid/types/grants/pell',
    'https://www.sba.gov/funding-programs/grants',
    'https://www.acf.hhs.gov/ocs/programs/liheap',
  ]
  for (const url of govUrls) {
    assert.equal(validateUrlFormat(url).valid, true, `Should accept .gov URL: ${url}`)
  }
})

test('validateUrlFormat: accepts legitimate .org and .edu URLs', () => {
  const urls = [
    'https://www.unitedway.org/find-your-united-way',
    'https://www.feedingamerica.org/find-your-local-foodbank',
    'https://www.harvard.edu/financial-aid',
  ]
  for (const url of urls) {
    assert.equal(validateUrlFormat(url).valid, true, `Should accept: ${url}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Required Fields
// ═══════════════════════════════════════════════════════════════════════════════

test('validateRequiredFields: accepts complete opportunity', () => {
  const opp = {
    title: 'Ohio Emergency Assistance',
    sponsor: 'Ohio DHS',
    description: 'Emergency assistance for families',
    source_url: 'https://ohio.gov/aid',
  }
  const result = validateRequiredFields(opp)
  assert.equal(result.valid, true)
  assert.equal(result.missing.length, 0)
})

test('validateRequiredFields: rejects missing title', () => {
  const result = validateRequiredFields({
    sponsor: 'Test',
    source_url: 'https://test.gov/grant',
  })
  assert.equal(result.valid, false)
  assert.ok(result.missing.includes('title'))
})

test('validateRequiredFields: rejects short title (<5 chars)', () => {
  const result = validateRequiredFields({
    title: 'Aid',
    sponsor: 'Test',
    source_url: 'https://test.gov/grant',
  })
  assert.equal(result.valid, false)
  assert.ok(result.missing.includes('title'))
})

test('validateRequiredFields: rejects missing sponsor AND description', () => {
  const result = validateRequiredFields({
    title: 'Test Grant Program',
    source_url: 'https://test.gov/grant',
  })
  assert.equal(result.valid, false)
  assert.ok(result.missing.includes('sponsor_or_description'))
})

test('validateRequiredFields: accepts sponsor without description', () => {
  const result = validateRequiredFields({
    title: 'Test Grant Program',
    sponsor: 'Test Agency',
    source_url: 'https://test.gov/grant',
  })
  assert.equal(result.valid, true)
})

test('validateRequiredFields: accepts description without sponsor', () => {
  const result = validateRequiredFields({
    title: 'Test Grant Program',
    description: 'A grant program for testing purposes.',
    source_url: 'https://test.gov/grant',
  })
  assert.equal(result.valid, true)
})

test('validateRequiredFields: rejects missing valid URL', () => {
  const result = validateRequiredFields({
    title: 'Test Grant Program',
    sponsor: 'Test Agency',
  })
  assert.equal(result.valid, false)
  assert.ok(result.missing.includes('valid_url'))
})

test('validateRequiredFields: rejects placeholder URL as no URL', () => {
  const result = validateRequiredFields({
    title: 'Test Grant Program',
    sponsor: 'Test Agency',
    source_url: 'https://example.com/fake',
  })
  assert.equal(result.valid, false)
  assert.ok(result.missing.includes('valid_url'))
})

test('validateRequiredFields: accepts any valid URL field (url, source_url, application_url, evidence_url)', () => {
  const fields = ['url', 'source_url', 'application_url', 'evidence_url']
  for (const field of fields) {
    const opp = {
      title: 'Test Grant Program',
      sponsor: 'Test Agency',
      [field]: 'https://grants.gov/test',
    }
    const result = validateRequiredFields(opp)
    assert.equal(result.valid, true, `Should accept URL in field "${field}"`)
  }
})

test('validateRequiredFields: rejects null/undefined input', () => {
  assert.equal(validateRequiredFields(null).valid, false)
  assert.equal(validateRequiredFields(undefined).valid, false)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate Detection
// ═══════════════════════════════════════════════════════════════════════════════

test('checkDuplicate: detects duplicate by source+source_id', () => {
  const seenUrls = new Set()
  const seenSourceIds = new Set()

  const opp1 = { source: 'grants.gov', source_id: '12345', url: 'https://grants.gov/12345' }
  const opp2 = { source: 'grants.gov', source_id: '12345', url: 'https://grants.gov/12345-v2' }

  const r1 = checkDuplicate(opp1, seenUrls, seenSourceIds)
  assert.equal(r1.isDuplicate, false)

  const r2 = checkDuplicate(opp2, seenUrls, seenSourceIds)
  assert.equal(r2.isDuplicate, true)
  assert.equal(r2.reason, 'duplicate_source_id')
})

test('checkDuplicate: detects duplicate by normalized URL', () => {
  const seenUrls = new Set()
  const seenSourceIds = new Set()

  const opp1 = { source: 'crawler_a', source_id: 'a1', url: 'https://grants.gov/program?utm_source=foo' }
  const opp2 = { source: 'crawler_b', source_id: 'b1', url: 'https://grants.gov/program?utm_source=bar' }

  const r1 = checkDuplicate(opp1, seenUrls, seenSourceIds)
  assert.equal(r1.isDuplicate, false)

  const r2 = checkDuplicate(opp2, seenUrls, seenSourceIds)
  assert.equal(r2.isDuplicate, true)
  assert.equal(r2.reason, 'duplicate_url')
})

test('checkDuplicate: different source_ids and URLs are not duplicates', () => {
  const seenUrls = new Set()
  const seenSourceIds = new Set()

  const opp1 = { source: 'grants.gov', source_id: '111', url: 'https://grants.gov/111' }
  const opp2 = { source: 'grants.gov', source_id: '222', url: 'https://grants.gov/222' }

  checkDuplicate(opp1, seenUrls, seenSourceIds)
  const r2 = checkDuplicate(opp2, seenUrls, seenSourceIds)
  assert.equal(r2.isDuplicate, false)
})

test('checkDuplicate: case insensitive URL dedup', () => {
  const seenUrls = new Set()
  const seenSourceIds = new Set()

  const opp1 = { source: 'a', source_id: '1', url: 'https://Grants.Gov/Program' }
  const opp2 = { source: 'b', source_id: '2', url: 'https://grants.gov/program' }

  checkDuplicate(opp1, seenUrls, seenSourceIds)
  const r2 = checkDuplicate(opp2, seenUrls, seenSourceIds)
  assert.equal(r2.isDuplicate, true)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Strict Validation (combined)
// ═══════════════════════════════════════════════════════════════════════════════

test('validateOpportunityStrict: accepts well-formed opportunity', () => {
  const opp = {
    title: 'Ohio Emergency Housing Program',
    sponsor: 'Ohio Department of Development',
    description: 'Housing assistance for Ohio residents',
    source_url: 'https://development.ohio.gov/housing',
  }
  const result = validateOpportunityStrict(opp)
  assert.equal(result.valid, true, `Should be valid, got errors: ${result.errors.join(', ')}`)
})

test('validateOpportunityStrict: rejects opportunity with placeholder URL', () => {
  const opp = {
    title: 'Fake Grant Program',
    sponsor: 'Test Agency',
    url: 'https://example.com/fake',
  }
  const result = validateOpportunityStrict(opp)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('url') || e.includes('placeholder')))
})

test('validateOpportunityStrict: rejects loan opportunity', () => {
  const opp = {
    title: 'Small Business Loan Program',
    sponsor: 'Lending Corp',
    description: 'Low-interest business loan with 5.5% APR',
    source_url: 'https://lendingcorp.com/loan',
  }
  const result = validateOpportunityStrict(opp)
  assert.equal(result.valid, false)
  assert.ok(result.errors.includes('loan_like'))
})

test('validateOpportunityStrict: rejects matching-funds opportunity', () => {
  const opp = {
    title: 'Dollar-for-Dollar Match Grant',
    sponsor: 'Matching Corp',
    description: 'Requires 1:1 match from applicant',
    source_url: 'https://matchcorp.com/grant',
    requires_match: true,
  }
  const result = validateOpportunityStrict(opp)
  assert.equal(result.valid, false)
  assert.ok(result.errors.includes('matching_funds'))
})

test('validateOpportunityStrict: rejects opportunity with no URL', () => {
  const opp = {
    title: 'Grant With No URL',
    sponsor: 'Mystery Agency',
    description: 'A grant that has no URL at all',
  }
  const result = validateOpportunityStrict(opp)
  assert.equal(result.valid, false)
})

test('validateOpportunityStrict: rejects null input', () => {
  const result = validateOpportunityStrict(null)
  assert.equal(result.valid, false)
})

test('validateOpportunityStrict: warns on expired deadline but still valid', () => {
  const opp = {
    title: 'Expired But Still Useful Grant',
    sponsor: 'Past Agency',
    description: 'This grant had a deadline last year',
    source_url: 'https://pastagency.gov/grant',
    deadline: '2020-01-01',
  }
  const result = validateOpportunityStrict(opp)
  // Expired deadlines are warnings, not hard rejections
  assert.ok(result.warnings.includes('deadline_passed'))
})
