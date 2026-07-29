import assert from 'node:assert/strict'
import { computeMatchDecision } from '../backend/crawler-os/matchEngine.js'
import { applyNeedFirstScoring } from '../backend/services/matching/needFirstScoringAdapter.js'
import { evaluateNeedFirstMatchPolicy } from '../backend/services/matching/needFirstMatchPolicy.js'
import { restorePersistedMatchTruth } from '../backend/services/matching/persistedMatchTruth.js'
import { reconcileNeedFirstProfileMatches } from '../backend/services/matching/needFirstReconciler.js'

const context = {
  profile: { id: 'student-test', primary_type: 'student', state: 'TN' },
  sections: {
    education: {
      intended_major: 'Forensic Science',
      gpa: 3.84,
      target_colleges: ['Middle Tennessee State University'],
    },
    university_applications: {
      applications: [{ name: 'Middle Tennessee State University', status: 'committed' }],
    },
    family_life: {}, occupation: {}, demographics: {},
  },
  signals: { location: { state: 'TN' } },
  profileNorm: {
    isStudent: true,
    entityType: 'student',
    education: { intendedMajor: 'Forensic Science' },
    academics: { gpa: 3.84 },
    needCategories: ['education'],
    effectiveFacets: ['student'],
  },
}

const matched = (...points) => ({
  matched: points,
  credit: points.reduce((sum, point) => sum + Number(point.credit || 0), 0),
})

const tests = []
async function test(name, fn) {
  await fn()
  tests.push(name)
}

await test('unrelated institution rejected', () => {
  const result = evaluateNeedFirstMatchPolicy({
    profileContext: context,
    profileNorm: context.profileNorm,
    opportunity: {
      title: 'University at Buffalo Merit Scholarship',
      sponsor: 'University at Buffalo',
      opportunity_kind: 'SCHOLARSHIP',
    },
    dataPointEval: matched({ kind: 'academic', value: 'GPA 3.84', credit: 1 }),
    matchedNeeds: ['education'],
  })
  assert.equal(result.decision, 'REJECT')
})

await test('committed institution and major retained', () => {
  const result = evaluateNeedFirstMatchPolicy({
    profileContext: context,
    profileNorm: context.profileNorm,
    opportunity: {
      title: 'Middle Tennessee State University Forensic Science Scholarship',
      sponsor: 'Middle Tennessee State University',
      opportunity_kind: 'SCHOLARSHIP',
    },
    dataPointEval: matched(
      { kind: 'academic', value: 'GPA 3.84', credit: 1 },
      { kind: 'interest', value: 'forensic science', credit: 1 },
    ),
    matchedNeeds: ['education'],
  })
  assert.equal(result.decision, null)
  assert.equal(result.purposeAnchor, true)
})

await test('fit bonus bounded and no-purpose direct source rejected', () => {
  const result = applyNeedFirstScoring({
    canonical: {
      score: 14,
      decision: 'ACCEPT',
      explanation: 'Strong match',
      reasons: [],
      matchedNeeds: [],
      match_explain: {
        dataPointEvidence: {
          total: 20,
          credit: 1,
          bonus_credit: 1,
          matched: [{ kind: 'applicant_type', value: 'student', credit: 0.5 }],
        },
        scoreBreakdown: {
          data_point_total: 20,
          data_point_credit: 1,
          data_point_bonus_credit: 1,
          eligibility_factor: 1,
          geo_factor: 1,
        },
      },
    },
    profileContext: context,
    opportunity: {
      title: 'Generic National Opportunity',
      sponsor: 'Generic Funder',
      opportunity_kind: 'DIRECT_GRANT',
    },
  })
  assert.equal(result.decision, 'REJECT')
  assert.ok(result.score < 7)
  assert.equal(result.match_explain.dataPointEvidence.bonus_credit, 0.5)
})

await test('Crawler OS facade applies policy', () => {
  const result = computeMatchDecision({
    id: 'nurse-1',
    title: 'Future Nurses Scholarship',
    sponsor: 'Nursing Foundation',
    summary: 'Scholarship for nursing students.',
    kind: 'SCHOLARSHIP',
    applicant_types: ['student'],
    need_categories: ['education'],
    geography: { national: true, states: [], counties: [], zips: [] },
    funding: { amount_min: 1000, amount_max: 1000 },
    apply_url: 'https://example.test/apply',
  }, {
    profile_id: 'student-test',
    applicant_types: ['student'],
    needs: ['education'],
    keywords: ['forensic science'],
    location: { state: 'TN' },
  }, {
    profileRow: context.profile,
    profileSections: context.sections,
    signals: context.signals,
    profileNorm: context.profileNorm,
  })
  assert.equal(result.decision, 'reject')
  assert.equal(result.match_explain.scoring_policy_version, 'need_first_v1')
})

await test('persisted truth hides rejected direct row and keeps resource REVIEW', () => {
  const canonical = [
    { id: 'bad', title: 'Wrong Program', opportunity_kind: 'DIRECT_GRANT', match_score: 90, match_decision: 'ACCEPT' },
    { id: 'dir', title: 'Search Directory', opportunity_kind: 'DIRECTORY', is_directory: true, match_score: 20, match_decision: 'ACCEPT' },
  ]
  const persisted = [
    {
      ...canonical[0], match_score: 12, match_decision: 'REVIEW',
      match_explain_json: {
        dataPointEvidence: { total: 20, credit: 0.5, matched: [{ kind: 'applicant_type', value: 'student', credit: 0.5 }] },
        scoreBreakdown: { data_point_total: 20, data_point_credit: 0.5 },
      },
    },
    { ...canonical[1], match_score: 9, match_decision: 'ACCEPT', match_explain_json: {} },
  ]
  const result = restorePersistedMatchTruth(canonical, persisted, { profileContext: context })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'dir')
  assert.equal(result[0].match_decision, 'REVIEW')
})

await test('reconciler persists same policy decision', async () => {
  const updates = []
  const row = {
    profile_id: 'student-test', opportunity_id: 'bad-1', id: 'bad-1',
    title: 'University at Buffalo Merit Scholarship', sponsor: 'University at Buffalo',
    opportunity_kind: 'SCHOLARSHIP', opportunity_type: 'scholarship',
    match_score: 16, match_decision: 'accept', match_explanation: 'Old match',
    match_reasons: '[]', matcher_version: 'crawler-os',
    match_explain_json: JSON.stringify({
      matchedNeeds: ['education'],
      dataPointEvidence: { total: 20, credit: 1, matched: [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }] },
      scoreBreakdown: { data_point_total: 20, data_point_credit: 1 },
    }),
  }
  const db = {
    prepare(sql) {
      return {
        async all() { return /^\s*SELECT/.test(sql) ? [row] : [] },
        async run(...params) { updates.push(params); return { changes: 1 } },
      }
    },
  }
  const summary = await reconcileNeedFirstProfileMatches(db, {
    profileId: 'student-test', profileContext: context,
  })
  assert.equal(summary.updated, 1)
  assert.equal(summary.rejected, 1)
  assert.equal(updates[0][1], 'reject')
})

assert.equal(tests.length, 6, `expected 6 completed tests, got ${tests.length}`)
console.log(`[need-first-build-self-test] PASS ${tests.length}/6`)
