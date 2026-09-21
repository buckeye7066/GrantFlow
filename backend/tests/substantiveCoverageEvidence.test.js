import { describe, it, expect } from 'vitest'
import { scoreOpportunity, computeMatchDecision } from '../services/matchEngine.js'
import { buildProfileDataPointInventory, evaluateDataPointMatches } from '../services/profileDataPoints.js'
import { ACCEPT_SCORE } from '../config/matchThresholds.js'

const profile = { id: 'synthetic-biomedical-lab', primary_type: 'nonprofit', state: 'TN',
  needs: ['biotechnology research', 'biopharmaceutical development', 'public health enhancement', 'advanced laboratory equipment'] }
const common = { is_national: true, applicant_types: ['nonprofit'], application_url: 'https://example-funder.org/apply' }
const mathematical = { ...common, id: 'synthetic-mathematics', title: 'Mathematical Sciences Infrastructure',
  description: 'Nonprofit organizations may apply. Support the health of the mathematical sciences research community through training, collaboration, infrastructure and professional development.',
  categories: ['education', 'programs', 'capital'] }
const fish = { ...common, id: 'synthetic-fish', title: 'Fish Passage Restoration',
  description: 'Nonprofit organizations may apply. Restore fish passage and river habitat with community development, research, education, equipment and infrastructure projects.',
  categories: ['environment', 'programs', 'capital'] }
const biomedical = { ...common, id: 'synthetic-biomedical', title: 'Biomedical Laboratory Research',
  description: 'Nonprofit organizations may apply for biotechnology research, biopharmaceutical development, public health enhancement and advanced laboratory equipment.',
  categories: ['research'] }

describe('substantive coverage evidence', () => {
  const student = { primary_type: 'college_student', needs: ['education'], interests: Array.from({ length: 40 }, (_, i) => `unrelated interest ${i}`) }
  const education = { title: 'Community Education Award', description: 'College students may apply for this scholarship to pay education expenses.',
    applicant_types: ['individual'], is_national: true, application_url: 'https://example-funder.org/apply' }
  it('admits a supported need without inflating coverage of unrelated profile facts', () => {
    const result = computeMatchDecision(student, education)
    expect(result.score).toBeLessThan(ACCEPT_SCORE)
    expect(result.decision).toBe('ACCEPT')
    expect(result.match_explain.dataPointEvidence.matched).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'need', credit: 1 })]))
  })
  it.each([
    { requires_match: true },
    { application_url: 'https://example.org/apply' },
    { opportunity_kind: 'DIRECTORY', is_directory: true },
  ])('keeps substantive holds on a low-coverage positive match: %j', hold => {
    expect(computeMatchDecision(student, { ...education, ...hold }).decision).not.toBe('ACCEPT')
  })
  it('does not infer organization eligibility from a positive need alone', () => {
    const result = computeMatchDecision({ ...student, primary_type: 'nonprofit' }, {
      ...education, applicant_types: [], description: 'Support for education expenses.',
    })
    expect(result.decision).not.toBe('ACCEPT')
  })
  it.each([mathematical, fish])('$title cannot claim specialized biomedical needs from generic words', opportunity => {
    const result = scoreOpportunity(profile, opportunity)
    expect(result.match_explain.dataPointEvidence.matched.filter(p => p.kind === 'need')).toEqual([])
    expect(computeMatchDecision(profile, opportunity).decision).not.toBe('ACCEPT')
  })
  it('adding mined narrative words cannot increase declared-fact coverage', () => {
    const verbose = { ...profile, keywords: ['research', 'community', 'health', 'training', 'infrastructure', 'collaboration', 'development', 'r&d capital', 'and bioinformatics programs.'] }
    const base = scoreOpportunity(profile, mathematical)
    const expanded = scoreOpportunity(verbose, mathematical)
    expect(expanded.match_explain.dataPointEvidence.total).toBe(base.match_explain.dataPointEvidence.total)
    expect(expanded.match_explain.dataPointEvidence.credit).toBe(base.match_explain.dataPointEvidence.credit)
    expect(expanded.score).toBe(base.score)
    expect(expanded.match_explain.dataPointEvidence.matched_count).toBe(base.match_explain.dataPointEvidence.matched_count)
    expect(expanded.match_explain.reasons.find(r => r.startsWith('Matches ')))
      .toBe(base.match_explain.reasons.find(r => r.startsWith('Matches ')))
  })
  it('preserves direct evidence for specific needs and a genuinely broad declared research need', () => {
    const exact = scoreOpportunity(profile, biomedical)
    expect(exact.match_explain.dataPointEvidence.matched.filter(p => p.kind === 'need')).toHaveLength(4)
    expect(exact.score).toBeGreaterThan(scoreOpportunity(profile, mathematical).score)
    expect(computeMatchDecision(profile, biomedical).decision).toBe('ACCEPT')
    const broad = scoreOpportunity({ ...profile, needs: ['research'] }, mathematical)
    expect(broad.match_explain.dataPointEvidence.matched).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'need', value: 'research', credit: 1 }),
    ]))
  })
  it('a broad source category cannot stand in for a full declared phrase', () => {
    const inventory = buildProfileDataPointInventory({ profile: { interests: ['bioinformatics programs', 'r&d capital'] } })
    const result = evaluateDataPointMatches({ inventory, oppSignals: ['programs', 'capital'] })
    expect(result.matched).toEqual([])
    expect(result.credit).toBe(0)
  })
})
