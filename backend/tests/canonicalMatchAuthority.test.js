import fs from 'fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../services/matchDecisionEngine.js', () => ({ MATCHER_VERSION: 'test-canonical-matcher-v1' }))
const MATCHER_VERSION = 'test-canonical-matcher-v1'
import {
  CANONICAL_MATCH_AUTHORITY,
  CanonicalMatchAuthorityError,
  assertCanonicalMatchDecision,
  canonicalMatchReceipt,
} from '../services/canonicalMatchAuthority.js'

function canonicalResult(overrides = {}) {
  return {
    score: 72,
    decision: 'REVIEW',
    matcherVersion: MATCHER_VERSION,
    scoringPolicyVersion: 'need-first-v1',
    scoreScaleId: 'need-first-100',
    evaluatedAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

describe('canonical match authority boundary', () => {
  it('emits an authority receipt without rescoring or changing the decision', () => {
    const decision = canonicalResult()
    expect(assertCanonicalMatchDecision(decision)).toBe(decision)
    expect(canonicalMatchReceipt(decision)).toEqual({
      authority: CANONICAL_MATCH_AUTHORITY,
      contract_version: 'canonical-match-result-v1',
      matcher_version: MATCHER_VERSION,
      scoring_policy_version: 'need-first-v1',
      score_scale_id: 'need-first-100',
      evaluated_at: '2026-08-17T12:00:00.000Z',
    })
  })

  it('fails closed on a result from a different matcher version', () => {
    expect(() => assertCanonicalMatchDecision(canonicalResult({ matcherVersion: 'parallel-scorer-v2' })))
      .toThrow(CanonicalMatchAuthorityError)
  })

  it('fails closed on invalid decision semantics', () => {
    expect(() => assertCanonicalMatchDecision(canonicalResult({ decision: 'maybe' })))
      .toThrow('invalid decision')
  })

  it('is asserted at the live foundation scoring boundary', () => {
    const source = fs.readFileSync(new URL('../routes/foundations.js', import.meta.url), 'utf8')
    expect(source).toContain('assertCanonicalMatchDecision(computeMatchDecision(')
    expect(source).toContain('match_authority: decision ? canonicalMatchReceipt(decision) : null')
  })
})
