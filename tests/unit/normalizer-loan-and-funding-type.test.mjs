/**
 * Opportunity normalizer: loan detection + funding-type defaulting.
 *
 * Mission System 2 rules guarded here:
 *  - Unknown/unrecognized funding type must stay 'unknown' (→ REVIEW), never
 *    silently default to 'grant'.
 *  - Loan detection must inspect the FULL text (title + description +
 *    eligibility) plus funding_type/opportunity_type — not the title alone — so
 *    a loan disclosed only in the body is still flagged. Loan forgiveness /
 *    repayment assistance must NOT be flagged as a loan.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeOpportunity } from '../../backend/services/opportunityNormalizer.js'

test('unrecognized funding type stays "unknown", not "grant"', () => {
  const opp = normalizeOpportunity({
    title: 'Cooperative Agreement Opportunity',
    funding_type: 'cooperative_agreement',
    application_url: 'https://example.org/apply',
  })
  assert.equal(opp.fundingType, 'unknown')
})

test('empty funding type is "unknown"', () => {
  const opp = normalizeOpportunity({ title: 'X', application_url: 'https://x.org' })
  assert.equal(opp.fundingType, 'unknown')
})

test('known funding type maps correctly (regression)', () => {
  assert.equal(normalizeOpportunity({ title: 'G', funding_type: 'grant', application_url: 'https://x.org' }).fundingType, 'grant')
  assert.equal(normalizeOpportunity({ title: 'S', funding_type: 'scholarship', application_url: 'https://x.org' }).fundingType, 'scholarship')
  assert.equal(normalizeOpportunity({ title: 'L', funding_type: 'loan', application_url: 'https://x.org' }).fundingType, 'loan')
})

test('loan disclosed only in the description is detected (not title-only)', () => {
  const opp = normalizeOpportunity({
    title: 'Small Business Capital Program',
    description: 'A low-interest loan to help businesses purchase equipment. Funds must be repaid over 5 years.',
    application_url: 'https://example.org/apply',
  })
  assert.equal(opp.isLoan, true)
})

test('loan in funding_type/opportunity_type metadata is detected', () => {
  assert.equal(
    normalizeOpportunity({ title: 'Equipment Fund', opportunity_type: 'loan', application_url: 'https://x.org' }).isLoan,
    true,
  )
})

test('loan forgiveness / repayment assistance is NOT flagged as a loan', () => {
  const forgiveness = normalizeOpportunity({
    title: 'Public Service Loan Forgiveness Assistance',
    description: 'Helps qualifying borrowers with loan forgiveness and repayment relief. This is not a loan.',
    application_url: 'https://example.org/apply',
  })
  assert.equal(forgiveness.isLoan, false)
})

test('a plain grant with no loan language is not a loan', () => {
  const grant = normalizeOpportunity({
    title: 'Community Arts Grant',
    description: 'Direct grant funding for local arts programs. No repayment required.',
    funding_type: 'grant',
    application_url: 'https://example.org/apply',
  })
  assert.equal(grant.isLoan, false)
})
