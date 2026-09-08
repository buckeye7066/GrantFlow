import { expect, it } from 'vitest'
import { normalizeConditionTerm } from '../config/conditionTerms.js'
import { conditionCoveredBySource, conditionCoverageKey, sourceServesDeclaredCondition } from '../config/sourceLanes.js'
import { namedProfileConditions } from '../config/conditionSpecificity.js'
import { buildConditionQueries } from '../services/coverageAudit/conditionSourceSearch.js'

it('routes a pasted HBP condition through the existing hypertension lane and search vocabulary', () => {
  const source = { keywords: ['hypertension', 'high blood pressure'] }
  for (const condition of ['[]hbp', '[ ] HBP', 'HTN', 'high blood pressure']) {
    expect(normalizeConditionTerm(condition)).toBe('hypertension')
    expect(conditionCoveredBySource(condition, source)).toBe(true)
    expect(sourceServesDeclaredCondition(source, [condition])).toBe(true)
    expect(conditionCoverageKey(condition)).toBe('hypertension')
    expect(namedProfileConditions({namedHealthConditions:[condition]})).toEqual(['hypertension'])
    expect(buildConditionQueries(condition)[0]).toBe('hypertension patient assistance program financial help')
  }
})
it('does not interpret denials, unknown abbreviations, or inherited property names as diagnoses', () => {
  expect(namedProfileConditions({namedHealthConditions:['no HBP']})).toEqual([])
  expect(normalizeConditionTerm('No HBP')).toBe('no hbp')
  expect(normalizeConditionTerm('constructor')).toBe('constructor')
  expect(normalizeConditionTerm('[] rare condition')).toBe('rare condition')
})
