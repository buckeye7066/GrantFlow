import { computeMatchDecision } from '../backend/crawler-os/matchEngine.js'
import { applyNeedFirstScoring } from '../backend/services/matching/needFirstScoringAdapter.js'
import { evaluateNeedFirstMatchPolicy } from '../backend/services/matching/needFirstMatchPolicy.js'
import { restorePersistedMatchTruth } from '../backend/services/matching/persistedMatchTruth.js'
import { reconcileNeedFirstProfileMatches } from '../backend/services/matching/needFirstReconciler.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const profileContext = {
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
    family_life: {},
    occupation: {},
    demographics: {},
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

function matched(...points) {
  return { matched: points, credit: points.reduce((sum, point) => sum + Number(point.credit || 0), 0) }
}

async function runTests() {
  const tests = []
  const test = async (name, fn) => {
    await fn()
    tests.push({ name, ok: true })
  }

  await test('policy rejects unrelated institution', () => {
    const result = evaluateNeedFirstMatchPolicy({
      profileContext,
      profileNorm: profileContext.profileNorm,
      opportunity: {
        title: 'University at Buffalo Merit Scholarship',
        sponsor: 'University at Buffalo',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched({ kind: 'academic', value: 'GPA 3.84', credit: 1 }),
      matchedNeeds: ['education'],
    })
    assert(result.decision === 'REJECT', `expected REJECT, got ${result.decision}`)
  })

  await test('policy keeps committed institution and major', () => {
    const result = evaluateNeedFirstMatchPolicy({
      profileContext,
      profileNorm: profileContext.profileNorm,
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
    assert(result.decision === null, `expected no rejection override, got ${result.decision}`)
    assert(result.purposeAnchor === true, 'expected purpose anchor')
  })

  await test('adapter bounds fit bonus and rejects no-purpose source', () => {
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
      profileContext,
      opportunity: {
        title: 'Generic National Opportunity',
        sponsor: 'Generic Funder',
        opportunity_kind: 'DIRECT_GRANT',
      },
    })
    assert(result.decision === 'REJECT', `expected REJECT, got ${result.decision}`)
    assert(result.score < 7, `expected below-review score, got ${result.score}`)
    assert(result.match_explain.dataPointEvidence.bonus_credit === 0.5, 'expected half-credit bonus cap')
  })

  await test('Crawler OS facade rejects wrong profession', () => {
    const decision = computeMatchDecision({
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
      profileRow: profileContext.profile,
      profileSections: profileContext.sections,
      signals: profileContext.signals,
      profileNorm: profileContext.profileNorm,
    })
    assert(decision.decision === 'reject', `expected crawler reject, got ${decision.decision}`)
    assert(decision.match_explain.scoring_policy_version === 'need_first_v1', 'missing policy version')
  })

  await test('persisted truth filters direct REJECT and keeps resource REVIEW', () => {
    const canonical = [
      { id: 'bad', title: 'Wrong Program', opportunity_kind: 'DIRECT_GRANT', match_score: 90, match_decision: 'ACCEPT' },
      { id: 'dir', title: 'Search Directory', opportunity_kind: 'DIRECTORY', is_directory: true, match_score: 20, match_decision: 'ACCEPT' },
    ]
    const persisted = [
      {
        ...canonical[0],
        match_score: 12,
        match_decision: 'REVIEW',
        match_explain_json: {
          dataPointEvidence: { total: 20, credit: 0.5, matched: [{ kind: 'applicant_type', value: 'student', credit: 0.5 }] },
          scoreBreakdown: { data_point_total: 20, data_point_credit: 0.5 },
        },
      },
      { ...canonical[1], match_score: 9, match_decision: 'ACCEPT', match_explain_json: {} },
    ]
    const result = restorePersistedMatchTruth(canonical, persisted, { profileContext })
    assert(result.length === 1, `expected one resource, got ${result.length}`)
    assert(result[0].id === 'dir', `expected directory, got ${result[0].id}`)
    assert(result[0].match_decision === 'REVIEW', `expected REVIEW, got ${result[0].match_decision}`)
  })

  await test('reconciler persists the same need-first decision', async () => {
    const updates = []
    const row = {
      profile_id: 'student-test',
      opportunity_id: 'bad-1',
      id: 'bad-1',
      title: 'University at Buffalo Merit Scholarship',
      sponsor: 'University at Buffalo',
      opportunity_kind: 'SCHOLARSHIP',
      opportunity_type: 'scholarship',
      match_score: 16,
      match_decision: 'accept',
      match_explanation: 'Old match',
      match_reasons: '[]',
      match_explain_json: JSON.stringify({
        matchedNeeds: ['education'],
        dataPointEvidence: {
          total: 20,
          credit: 1,
          matched: [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
        },
        scoreBreakdown: { data_point_total: 20, data_point_credit: 1 },
      }),
      matcher_version: 'crawler-os',
    }
    const db = {
      prepare(sql) {
        return {
          async all() { return sql.startsWith('SELECT') ? [row] : [] },
          async run(...params) { updates.push({ sql, params }); return { changes: 1 } },
        }
      },
    }
    const summary = await reconcileNeedFirstProfileMatches(db, {
      profileId: 'student-test',
      profileContext,
    })
    assert(summary.updated === 1, `expected one update, got ${summary.updated}`)
    assert(summary.rejected === 1, `expected one rejection, got ${summary.rejected}`)
    assert(updates[0].params[1] === 'reject', `expected persisted reject, got ${updates[0].params[1]}`)
  })

  return tests
}

export default async function handler(_request, response) {
  try {
    const tests = await runTests()
    response.status(200).json({
      ok: true,
      test_count: tests.length,
      tests,
    })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: String(error?.stack || '').split('\n').slice(0, 5),
    })
  }
}
