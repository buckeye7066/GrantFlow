import { describe, expect, it } from 'vitest'
import { evaluateNeedFirstMatchPolicy, enforceNeedFirstDecision } from '../services/matching/needFirstMatchPolicy.js'

function policy(title, topics = ['biotechnology'], matched = ['research']) {
  return evaluateNeedFirstMatchPolicy({
    profileContext: { profile: { primary_type: 'small_business', needs: ['research', ...topics] }, sections: {} },
    opportunity: { title, description: 'Research grant for eligible small businesses.', applicant_types: ['small_business'], opportunity_kind: 'GRANT' },
    dataPointEval: { matched: matched.map(value => ({ kind: 'need', value, credit: 1 })) },
    matchedNeeds: matched,
  })
}

describe('research scope must be grounded beyond a generic research need', () => {
  it.each(['Topology', 'Mathematical Sciences Infrastructure Program', 'Economics'])('holds a biology profile at REVIEW for %s', title => {
    const result = policy(title)
    expect(result.reviewOnly).toBe(true)
    expect(result.reasons.join(' ')).toContain('Research scope')
    expect(result.hardMismatch).toBe(false)
    expect(enforceNeedFirstDecision({ decision: 'ACCEPT' }, result).explanation).toContain('Research scope')
  })
  it('keeps matching mathematics and interdisciplinary scope eligible for acceptance', () => {
    expect(policy('Topology', ['mathematics']).reviewOnly).toBe(false)
    expect(policy('Mathematical Biology Research').reviewOnly).toBe(false)
    expect(policy('Topology', ['biotechnology', 'mathematics']).reviewOnly).toBe(false)
  })
  it('does not invent scope from silence or restrict a general research award', () => {
    expect(policy('Topology', []).reviewOnly).toBe(false)
    expect(policy('Small Business Research Grant').reviewOnly).toBe(false)
  })
  it('preserves independently matched specific needs', () => {
    expect(policy('Mathematical Sciences Infrastructure Program', ['biotechnology'], ['research', 'biotechnology']).reviewOnly).toBe(false)
  })
  it('uses canonical coverage evidence rather than legacy incidental need aliases', () => {
    const result = evaluateNeedFirstMatchPolicy({
      profileContext: { profile: { primary_type: 'small_business', needs: ['research', 'biotechnology'] } },
      opportunity: { title: 'Mathematical Sciences Infrastructure Program', opportunity_kind: 'GRANT' },
      dataPointEval: { matched: [{ kind: 'need', value: 'research', credit: 1 }] },
      matchedNeeds: ['health_medical'],
    })
    expect(result.reviewOnly).toBe(true)
  })
})
