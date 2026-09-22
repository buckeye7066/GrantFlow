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


test('budget-only magnitude words and imported amount ranges never become requested expenses', () => {
  for (const value of ['under $1 million', 'under_50k', 'approximately $50k', '$10,000 annually', '$1\u2013$2 million', '$1\u2014$2 million']) {
    assert.deepEqual(declaredNeedsFrom(profile, { financial_information: { funding_needs: value } }), ['business'], value)
  }
})

test('an explicit item with a price is preserved instead of discarded as a budget', () => {
  assert.deepEqual(declaredNeedsFrom(profile, { financial_information: { item_needs: ['equipment costing $50k'] } }), ['equipment costing 50k'])
})

test('category-only matching never scans expense text when there are no concrete requests', async () => {
  const { evaluateRequestedFundingUses } = await import('../../backend/services/matching/fundingUseEvidence.js')
  const row = { get description() { throw new Error('unnecessary expense scan') } }
  assert.deepEqual(evaluateRequestedFundingUses(row, []), [])
})


test('an explicit equipment item keeps its wording instead of becoming a broad technology category', () => {
  const declared = declaredNeedsFrom({ ...profile, tags: ['business'] }, { financial_information: { item_needs: ['equipment'] } })
  assert.deepEqual(declared, ['equipment'])
  const result = evaluateDeclaredNeedCoverage({ categories: ['technology_equipment'], description: 'Equipment purchases are prohibited.' }, declared)
  assert.equal(result.pass, false)
  assert.equal(result.requested_need_evidence[0].status, 'excluded')
})

test('canonical category requests continue to match without fabricating item-level promises', () => {
  const declared = declaredNeedsFrom(profile, { financial_information: { needs: ['equipment'] } })
  assert.deepEqual(declared, ['technology_equipment'])
  assert.equal(evaluateDeclaredNeedCoverage({ categories: ['technology_equipment'] }, declared).pass, true)
})


test('leading no never reverses a funding prohibition into positive coverage', () => {
  for (const description of ['No equipment costs are allowable.', 'No funds may be used for equipment.']) {
    const result = evaluateDeclaredNeedCoverage({ description }, ['laboratory equipment'])
    assert.equal(result.pass, false, description)
    assert.equal(result.requested_need_evidence[0].status, 'excluded', description)
  }
})

test('organizational capacity building is not real-property acquisition', () => {
  for (const description of ['Construction costs are not allowable.', 'Funds may be used for building acquisition.']) {
    const result = evaluateDeclaredNeedCoverage({ description }, ['capacity building'])
    assert.equal(result.pass, false, description)
    assert.equal(result.requested_need_evidence[0].status, 'unknown', description)
  }
  assert.equal(evaluateDeclaredNeedCoverage({ description: 'Funds may be used for capacity building.' }, ['capacity building']).pass, true)
})

test('persisted catalog eligibility columns retain funding-use evidence after reload', () => {
  for (const field of ['eligibility_bullets', 'eligibility_requirements']) {
    const result = evaluateDeclaredNeedCoverage({ [field]: JSON.stringify(['Equipment costs are allowable.']) }, ['laboratory equipment'])
    assert.equal(result.pass, true, field)
    assert.equal(result.requested_need_evidence[0].evidence[0].field, field)
  }
})

test('the cleanup gate keeps uncertain existing rows without certifying their expense coverage', async () => {
  const { gateCoversNeed } = await import('../../backend/services/robert/robertPipelineAudit.js')
  for (const description of ['This program supports research.', 'Equipment costs are allowable only with prior approval.']) {
    const result = gateCoversNeed({ description }, { needs: ['laboratory equipment'] })
    assert.equal(result.pass, true, 'uncertainty must not authorize deletion')
    assert.equal(result.verification_required, true)
    assert.equal(result.evidence.requested_need_coverage.pass, false)
  }
  assert.equal(gateCoversNeed({ description: 'Equipment costs are prohibited.' }, { needs: ['laboratory equipment'] }).pass, false)
})

test('funding-use uncertainty retains the earlier applicant-eligibility warning', async () => {
  const { applyNeedFirstScoring } = await import('../../backend/services/matching/needFirstScoringAdapter.js')
  const result = applyNeedFirstScoring({
    canonical: { decision: 'ACCEPT', score: 23, eligible: 'maybe', explanation: 'Research alignment.', reasons: [],
      missingEligibilityFields: ['income_eligibility'], match_explain: { missingEligibilityFields: ['income_eligibility'] } },
    profileContext: { profile, sections: { financial_information: { item_needs: ['laboratory equipment'] } } },
    opportunity: { title: 'Research Grant', description: 'Research funding for small businesses.', opportunity_kind: 'DIRECT_GRANT', opportunity_type: 'grant', application_url: 'https://funder.example/apply' },
  })
  assert.equal(result.decision, 'REVIEW')
  assert.match(result.explanation, /eligibility.*unconfirmed/i)
  assert.match(result.explanation, /funding terms/i)
})


test('funding-use admission changes invalidate earlier terminal promotion outcomes', async () => {
  const { PIPELINE_ADMISSION_POLICY_VERSION, pipelineAdmissionFingerprints } = await import('../../backend/services/opportunityMatcher.js')
  assert.notEqual(PIPELINE_ADMISSION_POLICY_VERSION, '1266043e312dfec930ef31db2e3f7c752aa0b5338e0d20333cde4476025cba8f')
  assert.equal(pipelineAdmissionFingerprints({ profile }, {}).policy_version, PIPELINE_ADMISSION_POLICY_VERSION)
})
