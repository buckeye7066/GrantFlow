/**
 * crawlerMatchEngineMultiAddress.test.js
 *
 * The crawler CANDIDATE PREFILTER (backend/services/crawlers/matchEngine.js)
 * must give in-state credit for ANY of a profile's addresses (home + school),
 * while keeping single-address behavior exactly as before.
 *
 * Proves:
 *  (a) single-address profile scores a same-state program identically with or
 *      without the `states` array (older snapshots unaffected),
 *  (b) a two-state profile gets in-state credit (+20, no penalty) for a program
 *      restricted to the SECONDARY state,
 *  (c) a program in a state in NEITHER profile state still takes the mismatch
 *      penalty,
 *  (d) adding a second address never lowers the score for a primary-state program.
 */
import { describe, it, expect } from 'vitest'
import { scoreProgram } from '../services/crawlers/matchEngine.js'

const baseAnalysis = (extra) => ({
  needs: new Set(['financial_assistance']),
  keywords: [],
  demographics: new Set(),
  health: new Set(),
  military: new Set(),
  family: new Set(),
  occupation: new Set(),
  immigration: new Set(),
  geographic: new Set(),
  interests: new Set(),
  sports: new Set(),
  income: {},
  education: {},
  applicantType: 'individual',
  applicantTypeExplicit: false,
  ...extra,
})

const TN_PROGRAM = {
  title: 'Tennessee Local Assistance',
  categories: ['financial_assistance'],
  stateRestriction: 'TN',
  type: 'program',
}
const OH_PROGRAM = { ...TN_PROGRAM, title: 'Ohio Local Assistance', stateRestriction: 'OH' }
const CA_PROGRAM = { ...TN_PROGRAM, title: 'California Local Assistance', stateRestriction: 'CA' }

describe('crawler prefilter: multi-address state matching', () => {
  it('(a) single-address profile: same-state score is identical with/without `states`', () => {
    const withStates = baseAnalysis({ location: { state: 'TN' }, states: ['TN'] })
    const withoutStates = baseAnalysis({ location: { state: 'TN' } })
    const a = scoreProgram(TN_PROGRAM, withStates)
    const b = scoreProgram(TN_PROGRAM, withoutStates)
    expect(a.matchScore).toBe(b.matchScore)
  })

  it('(b) two-state profile gets in-state credit for a SECONDARY-state program', () => {
    const ohHomeTnSchool = baseAnalysis({ location: { state: 'OH' }, states: ['OH', 'TN'] })
    const result = scoreProgram(TN_PROGRAM, ohHomeTnSchool)
    expect(result.matchReasons.some(r => /Available in TN/.test(r))).toBe(true)
    expect(result.matchReasons.some(r => /State mismatch/.test(r))).toBe(false)
  })

  it('(c) program in NEITHER profile state still takes the mismatch penalty', () => {
    const ohHomeTnSchool = baseAnalysis({ location: { state: 'OH' }, states: ['OH', 'TN'] })
    const result = scoreProgram(CA_PROGRAM, ohHomeTnSchool)
    expect(result.matchReasons.some(r => /State mismatch/.test(r))).toBe(true)
  })

  it('(d) adding a second address never lowers the score for a primary-state program', () => {
    const ohOnly = scoreProgram(OH_PROGRAM, baseAnalysis({ location: { state: 'OH' }, states: ['OH'] }))
    const ohPlusTn = scoreProgram(OH_PROGRAM, baseAnalysis({ location: { state: 'OH' }, states: ['OH', 'TN'] }))
    expect(ohPlusTn.matchScore).toBeGreaterThanOrEqual(ohOnly.matchScore)
  })
})
