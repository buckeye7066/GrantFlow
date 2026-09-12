import { expect, it } from 'vitest'
import { normalizeConditionTerm } from '../config/conditionTerms.js'
import { conditionCoveredBySource, conditionCoverageKey, sourceServesDeclaredCondition } from '../config/sourceLanes.js'
import { namedProfileConditions, conditionSpecificAlignment } from '../config/conditionSpecificity.js'
import { buildConditionQueries } from '../services/coverageAudit/conditionSourceSearch.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'

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

// Verbatim prod row: TennCare ECF CHOICES was a direct ACCEPT for profiles
// stating "No disability" or only mobility/cancer conditions (adjudication
// 2026-09-11), while the two owner-verified enrollees name IDD themselves.
const ECF_CHOICES = {
  title: 'Employment and Community First CHOICES (ECF CHOICES)',
  sponsor: 'TennCare',
  description: 'Official TennCare ECF CHOICES program page: employment and independent-community-living supports for Tennesseans with intellectual or developmental disabilities, including Essential Family Supports for family caregivers.',
}
const ecfText = `${ECF_CHOICES.title} ${ECF_CHOICES.description} ${ECF_CHOICES.sponsor}`.toLowerCase()
const ecfAlignment = (named) => conditionSpecificAlignment({
  profileNorm: { namedHealthConditions: named, hasDisabilityNeed: true },
  oppNorm: normalizeOpportunity(ECF_CHOICES),
  oppText: ecfText,
})

it('an intellectual/developmental disability program is condition-specific', () => {
  expect(normalizeOpportunity(ECF_CHOICES).diseaseSpecific).toBe(true)
})

it.each([
  ['Cognitive disability (F70)'],
  ['Mentally challenged'],
  ['intellectual disability'],
  ['Down syndrome'],
  ['autism'],
])('an IDD diagnosis stated as "%s" names the ECF CHOICES condition', (diagnosis) => {
  expect(ecfAlignment([normalizeConditionTerm(diagnosis)])).toBe('named')
})

it.each([
  [['cognitive disability']],
  [['anoxic brain injury']],
  [['mobility impairment']],
  [['stage 4 adenocarcinoma survivor', 'cipn']],
  [['no disability']],
])('%j does not name an intellectual/developmental disability', (named) => {
  expect(ecfAlignment(named)).toBe('unnamed')
})

it('an IDD diagnosis keeps its own wording, so an autism-specific row still matches autism', () => {
  expect(conditionSpecificAlignment({
    profileNorm: { namedHealthConditions: ['autism'], hasDisabilityNeed: true },
    oppNorm: { diseaseSpecific: true },
    oppText: 'family services grants for children living with autism',
  })).toBe('named')
})

it.each(['HBPish', 'preHTN', 'blood pressure monitoring', 'diabetes'])('does not infer hypertension from unrelated or partial text %s', (text) => {
  expect(conditionSpecificAlignment({
    profileNorm: { namedHealthConditions: ['hypertension'], hasChronicIllness: true },
    oppNorm: { diseaseSpecific: true },
    oppText: text,
  })).toBe('unnamed')
})
