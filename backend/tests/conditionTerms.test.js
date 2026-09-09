import { expect, it } from 'vitest'
import { normalizeConditionTerm } from '../config/conditionTerms.js'
import { conditionCoveredBySource, conditionCoverageKey, sourceServesDeclaredCondition } from '../config/sourceLanes.js'
import { namedProfileConditions, conditionSpecificAlignment } from '../config/conditionSpecificity.js'
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

it.each(['high blood pressure', 'HBP', 'HTN', 'high blood pressure patients'])('keeps a source expressed only as %s available to the matching diagnosis', (alias) => {
  const source = { keywords: [alias] }
  expect(conditionCoveredBySource('hypertension', source)).toBe(true)
  expect(sourceServesDeclaredCondition(source, ['high blood pressure'])).toBe(true)
})

it.each(['high blood pressure', 'HBP', 'HTN'])('retains named-condition alignment when opportunity text uses %s', (alias) => {
  expect(conditionSpecificAlignment({
    profileNorm: { namedHealthConditions: ['high blood pressure'], hasChronicIllness: true },
    oppNorm: { diseaseSpecific: true },
    oppText: `Financial assistance for patients with ${alias}.`,
  })).toBe('named')
})

it.each(['HBPish', 'preHTN', 'blood pressure monitoring', 'diabetes'])('does not infer hypertension from unrelated or partial text %s', (text) => {
  expect(conditionSpecificAlignment({
    profileNorm: { namedHealthConditions: ['hypertension'], hasChronicIllness: true },
    oppNorm: { diseaseSpecific: true },
    oppText: text,
  })).toBe('unnamed')
})
