import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreOpportunityForProfile,
  scoreOpportunityAcrossProfiles,
} from '../../backend/services/robert/robertMatchBridge.js'

const PROFILE_CTX = {
  profile: { id: 'p1', primary_type: 'volunteer_fire_department', state: 'TN' },
  sections: { location_focus: { state: 'TN' } },
  signals: { entityType: 'volunteer_fire_department' },
}

describe('robertMatchBridge — uses canonical computeMatchDecision only', () => {
  it('forwards profile context to the engine and shapes the result', async () => {
    const fakeCompute = (profile, opp, opts) => {
      assert.equal(profile.id, 'p1', 'profile passed through')
      assert.ok(opts.profileSections, 'sections forwarded')
      return {
        score: 87,
        decision: 'ACCEPT',
        reasons: ['matched applicant_type', 'state matched'],
        eligible: true,
        missingEligibilityFields: [],
        explanation: 'Strong match',
        match_explain: { matchedSignals: ['type'] },
        matcherVersion: '4.1.2',
      }
    }
    const result = await scoreOpportunityForProfile({
      profileContext: PROFILE_CTX,
      opportunity: { id: 'o1', title: 'X', sponsor: 'Y' },
      computeMatchDecision: fakeCompute,
    })
    assert.equal(result.score, 87)
    assert.equal(result.decision, 'ACCEPT')
    assert.deepEqual(result.reasons, ['matched applicant_type', 'state matched'])
    assert.equal(result.matcherVersion, '4.1.2')
  })

  it('returns NEEDS_PROFILE_DATA when profile context is missing', async () => {
    const result = await scoreOpportunityForProfile({
      profileContext: { profile: null },
      opportunity: { id: 'o' },
      computeMatchDecision: () => { throw new Error('should not be called') },
    })
    assert.equal(result.decision, 'NEEDS_PROFILE_DATA')
    assert.equal(result.score, 0)
  })

  it('skips profiles whose context cannot be loaded', async () => {
    const loaded = []
    const loadProfileContext = async (_db, id) => {
      loaded.push(id)
      if (id === 'bad') return null
      return { profile: { id, primary_type: 'family' }, sections: {}, signals: {} }
    }
    const fakeCompute = () => ({ score: 50, decision: 'REVIEW', reasons: [], eligible: 'maybe', missingEligibilityFields: [] })
    const decisions = await scoreOpportunityAcrossProfiles({
      db: {}, opportunity: { id: 'o' }, profileIds: ['p1', 'bad', 'p2'],
      loadProfileContext, computeMatchDecision: fakeCompute,
    })
    assert.equal(decisions.length, 2)
    assert.deepEqual(decisions.map((d) => d.profile_id), ['p1', 'p2'])
    assert.deepEqual(loaded, ['p1', 'bad', 'p2'])
  })
})
