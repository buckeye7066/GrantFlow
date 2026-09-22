import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declaredNeedsFrom, evaluateDeclaredNeedCoverage } from '../../backend/services/pipelinePrecision.js'

const profile = { primary_type: 'small_business' }
const requests = ['laboratory building', 'laboratory equipment', 'laboratory supplies', 'research salaries']
const needs = () => declaredNeedsFrom(profile, { financial_information: { item_needs: requests } })

test('explicit laboratory expenses are not replaced by the business-type default', () => {
  assert.deepEqual(needs(), requests)
})

test('a travel-only award cannot cover explicit laboratory startup requests through a business tag', () => {
  const result = evaluateDeclaredNeedCoverage({
    title: 'Biotechnology conference travel award',
    categories: ['business'],
    description: 'Funds support conference travel. Funds may not be used for equipment, supplies, buildings, or salaries.',
  }, needs())
  assert.equal(result.pass, false)
  assert.equal(result.detail, 'requested_needs_not_supported')
})

test('a budget amount is not a requested item and retains the existing type fallback', () => {
  assert.deepEqual(declaredNeedsFrom(profile, { financial_information: { funding_needs: '$225,000' } }), ['business'])
})
test('funding terms can cover part of the request without claiming the building is covered', () => {
  const result = evaluateDeclaredNeedCoverage({
    description: 'Eligible project costs include equipment, supplies, and salaries. Construction and building acquisition are not allowable.',
    source_url: 'https://funder.example/research-program',
  }, needs())
  assert.equal(result.pass, true)
  assert.deepEqual(result.matched, ['laboratory equipment', 'laboratory supplies', 'research salaries'])
  assert.deepEqual(result.requested_need_evidence.map(x => x.status), ['excluded', 'supported', 'supported', 'supported'])
  assert.equal(result.requested_need_evidence[1].evidence[0].source_url, 'https://funder.example/research-program')
})

test('merely mentioning laboratory equipment in research is not permission to buy it', () => {
  const result = evaluateDeclaredNeedCoverage({ description: 'Eligible small businesses research laboratory equipment reliability.' }, ['laboratory equipment'])
  assert.equal(result.pass, false)
  assert.equal(result.requested_need_evidence[0].status, 'unknown')
})

test('conditional equipment approval remains reviewable rather than confirmed', () => {
  const result = evaluateDeclaredNeedCoverage({ description: 'Equipment costs are allowable only with prior approval.' }, ['laboratory equipment'])
  assert.equal(result.pass, false)
  assert.equal(result.requested_need_evidence[0].status, 'conditional')
})

test('laboratory rental does not satisfy building purchase', () => {
  const result = evaluateDeclaredNeedCoverage({ description: 'Funds may be used for laboratory rent.' }, ['laboratory building'])
  assert.equal(result.pass, false)
})

test('a contradictory funding record does not choose the favorable equipment claim', () => {
  const result = evaluateDeclaredNeedCoverage({ description: 'Equipment costs are allowable. Equipment purchases are prohibited.' }, ['laboratory equipment'])
  assert.equal(result.pass, false)
  assert.equal(result.requested_need_evidence[0].status, 'conditional')
})

test('supplies for a different purpose do not satisfy laboratory supplies', () => {
  assert.equal(evaluateDeclaredNeedCoverage({ description: 'Funds cover school supplies.' }, ['laboratory supplies']).pass, false)
})

test('plain strings and section answer envelopes preserve actual requests but not contact or denial data', () => {
  assert.deepEqual(declaredNeedsFrom(profile, { financial_information: { answers: {
    item_needs: 'laboratory equipment; research salaries; no housing; someone@example.com',
  } } }), ['laboratory equipment', 'research salaries'])
})

test('canonical needs still permit genuine partial coverage', () => {
  const result = evaluateDeclaredNeedCoverage({ need_types_supported: ['food'] }, ['food', 'laboratory equipment'])
  assert.equal(result.pass, true)
  assert.deepEqual(result.matched, ['food'])
})

test('the canonical matcher carries the same requested-use verdict, not just the admission helper', async () => {
  const { computeMatchDecision } = await import('../../backend/services/matchEngine.js')
  const result = computeMatchDecision({ id: 'synthetic-lab', primary_type: 'small_business', state: 'TN' }, {
    title: 'Small Business Biotechnology Research Grant', source: 'grants_gov', categories: ['business'],
    description: 'US small businesses may apply for biotechnology research funding. Funds support conference travel. Equipment, supplies, buildings, and salaries are not allowable.',
    eligibility: 'US small businesses may apply.', applicant_types: ['small_business'], is_national: true,
    application_url: 'https://funder.example/apply',
  }, { profileSections: { financial_information: { item_needs: requests } } })
  assert.ok(result.match_explain.requested_need_coverage, 'canonical output must record requested-use evidence')
  assert.equal(result.match_explain.requested_need_coverage.pass, false)
  assert.notEqual(result.decision, 'ACCEPT')
})

test('the canonical adapter cannot resurrect a rejected opportunity while adding expense evidence', async () => {
  const { applyNeedFirstScoring } = await import('../../backend/services/matching/needFirstScoringAdapter.js')
  const result = applyNeedFirstScoring({
    canonical: { decision: 'REJECT', score: 0, explanation: 'Applicant is ineligible.', match_explain: {} },
    profileContext: { profile, sections: { financial_information: { item_needs: requests } } },
    opportunity: { description: 'Eligible costs include equipment, supplies, and salaries.' },
  })
  assert.equal(result.decision, 'REJECT')
  assert.equal(result.score, 0)
  assert.ok(result.match_explain.requested_need_coverage)
})


test('a trailing equipment exception remains conditional even when it omits the expense noun', () => {
  const result = evaluateDeclaredNeedCoverage({ description: 'Equipment costs are allowable except when used for commercial research.' }, ['laboratory equipment'])
  assert.equal(result.pass, false)
  assert.equal(result.requested_need_evidence[0].status, 'conditional')
})

test('an operational business tag cannot override the explicitly requested items', () => {
  assert.deepEqual(declaredNeedsFrom({ ...profile, tags: ['business'] }, { financial_information: { item_needs: requests } }), requests)
})
