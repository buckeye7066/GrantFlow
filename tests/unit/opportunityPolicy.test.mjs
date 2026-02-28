/**
 * Unit tests for opportunityPolicy.js — non-negotiable filters (URL, placeholder, loan, matching funds).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidRealUrl,
  isPlaceholderOpportunity,
  isLoanLike,
  isMatchingFunds,
  enforceOpportunityPolicy,
  filterByPolicy,
} from '../../backend/services/crawlers/opportunityPolicy.js'

test('isValidRealUrl: accepts https and http', () => {
  assert.equal(isValidRealUrl('https://www.grants.gov'), true)
  assert.equal(isValidRealUrl('http://example.org'), false)
  assert.equal(isValidRealUrl('https://studentaid.gov/pell'), true)
})

test('isValidRealUrl: rejects non-http(s), empty, invalid', () => {
  assert.equal(isValidRealUrl(''), false)
  assert.equal(isValidRealUrl('ftp://x.com'), false)
  assert.equal(isValidRealUrl('javascript:void(0)'), false)
  assert.equal(isValidRealUrl('https://example.com'), false)
  assert.equal(isValidRealUrl('https://placeholder.test'), false)
})

test('isPlaceholderOpportunity: detects example/placeholder hosts and lorem', () => {
  assert.equal(isPlaceholderOpportunity({ url: 'https://example.com/x', title: 'X' }), true)
  assert.equal(isPlaceholderOpportunity({ url: 'https://real.gov/x', title: 'Lorem ipsum grant' }), true)
  assert.equal(isPlaceholderOpportunity({ url: 'https://real.gov/x', title: 'Real Grant', description: 'Coming soon' }), true)
  assert.equal(isPlaceholderOpportunity({ url: 'https://www.grants.gov', title: 'Federal Grant', description: 'Real program' }), false)
})

test('isLoanLike: detects loan type and keywords', () => {
  assert.equal(isLoanLike({ opportunity_type: 'loan', title: 'X', url: 'https://x.gov' }), true)
  assert.equal(isLoanLike({ opportunity_type: 'microloan', title: 'X', url: 'https://x.gov' }), true)
  assert.equal(isLoanLike({ title: 'Small business loan program', url: 'https://sba.gov' }), true)
  assert.equal(isLoanLike({ title: 'Grant for repaying debt', url: 'https://x.gov' }), true)
  assert.equal(isLoanLike({ title: 'Federal Pell Grant', url: 'https://studentaid.gov', opportunity_type: 'grant' }), false)
})

test('isMatchingFunds: detects requires_match and keywords', () => {
  assert.equal(isMatchingFunds({ requires_match: true, title: 'X', url: 'https://x.gov' }), true)
  assert.equal(isMatchingFunds({ match_percentage: 50, title: 'X', url: 'https://x.gov' }), true)
  assert.equal(isMatchingFunds({ title: 'Program with matching funds required', url: 'https://x.gov' }), true)
  assert.equal(isMatchingFunds({ title: 'Dollar-for-dollar match grant', url: 'https://x.gov' }), true)
  assert.equal(isMatchingFunds({ title: 'Direct grant no match', url: 'https://x.gov', requires_match: false }), false)
})

test('enforceOpportunityPolicy: returns ok and reason', () => {
  const valid = { title: 'Real Grant', url: 'https://www.grants.gov/opp', description: 'A real program' }
  const out = enforceOpportunityPolicy(valid)
  assert.equal(out.ok, true)
  assert.equal(out.oppNormalizedMaybe, valid)

  assert.equal(enforceOpportunityPolicy({ title: 'X' }).ok, false)
  assert.equal(enforceOpportunityPolicy({ title: 'X', url: 'https://example.com' }).ok, false)
  assert.equal(enforceOpportunityPolicy({ title: 'Loan', url: 'https://x.gov', opportunity_type: 'loan' }).ok, false)
  assert.equal(enforceOpportunityPolicy({ title: 'Match', url: 'https://x.gov', requires_match: true }).ok, false)
})

test('enforceOpportunityPolicy: bumps rejectionCounts when provided', () => {
  const counts = {}
  enforceOpportunityPolicy({ title: 'Loan', url: 'https://x.gov', opportunity_type: 'loan' }, { rejectionCounts: counts })
  assert.equal(counts.loan_like, 1)
  const counts2 = {}
  enforceOpportunityPolicy({ title: 'Match', url: 'https://x.gov', requires_match: true }, { rejectionCounts: counts2 })
  assert.equal(counts2.matching_funds, 1)
})

test('filterByPolicy: returns only passed and accumulates counts', () => {
  const opportunities = [
    { title: 'Valid', url: 'https://www.grants.gov', description: 'Real' },
    { title: 'Loan', url: 'https://x.gov', opportunity_type: 'loan' },
    { title: 'Match', url: 'https://y.gov', requires_match: true },
    { title: 'No URL' },
  ]
  const counts = {}
  const { passed, rejectionCounts } = filterByPolicy(opportunities, { rejectionCounts: counts })
  assert.equal(passed.length, 1)
  assert.equal(passed[0].title, 'Valid')
  assert.ok((counts.loan_like ?? 0) + (counts.matching_funds ?? 0) + (counts.missing_url ?? 0) >= 3)
})
