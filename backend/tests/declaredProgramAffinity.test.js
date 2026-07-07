/**
 * declaredProgramAffinity.test.js
 *
 * FIX 2: a profile that DECLARES enrolling in a specific program (assistance
 * flags like medicaid_waiver / ecf_choices) must score that program's own
 * source lane (tn_ecf_choices) as a real match ABOVE the surfacing floor, even
 * though the lane's page text is keyword-thin and never literally states
 * "medicaid waiver". Evidence-based + type-agnostic (the flag must be present).
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { AUTO_ADD_SCORE } from '../config/matchThresholds.js'

// A TennCare ECF CHOICES member (the Gilbert/Kim class): waiver membership lives
// in government_assistance.other_programs free text.
const ECF_MEMBER_PROFILE = {
  id: 'p-ecf',
  primary_type: 'individual',
  state: 'TN',
  needs: ['disability', 'healthcare', 'employment'],
  disability_status: true,
}
const ECF_MEMBER_SECTIONS = {
  government_assistance: {
    other_programs: 'Medicaid Waiver Program (ECF CHOICES - TN)',
  },
  demographics: { disability_status: true },
}

// The ECF CHOICES program's own source lane — keyword-thin, as the real
// TennCare page is.
const ECF_SOURCE_OPP = {
  id: 'tn-ecf-benefit',
  title: 'Employment and Community First CHOICES (ECF CHOICES)',
  description:
    'Official TennCare program page: employment and community-living supports for Tennesseans with disabilities.',
  sponsor: 'TennCare',
  source: 'tn_ecf_choices',
  is_national: false,
  state: 'TN',
  applicant_types: ['individual', 'family', 'disabled', 'caregiver'],
  need_categories: ['disability', 'healthcare', 'employment', 'caregiving'],
  categories: ['disability', 'healthcare', 'employment', 'caregiving'],
  keywords: ['tn_ecf_choices', 'disability', 'healthcare'],
  application_url:
    'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
  is_directory: false,
}

describe('declared-program affinity end-to-end', () => {
  it('an ECF member scores their own ECF CHOICES lane above the surfacing floor', () => {
    const result = computeMatchDecision(ECF_MEMBER_PROFILE, ECF_SOURCE_OPP, {
      profileSections: ECF_MEMBER_SECTIONS,
    })
    expect(result.decision).not.toBe('REJECT')
    expect(result.score).toBeGreaterThanOrEqual(AUTO_ADD_SCORE)
  })

  it('the declared waiver membership is credited via the declared_program path', () => {
    const result = computeMatchDecision(ECF_MEMBER_PROFILE, ECF_SOURCE_OPP, {
      profileSections: ECF_MEMBER_SECTIONS,
    })
    const matched = result.match_explain?.dataPointEvidence?.matched ?? []
    const declared = matched.filter((m) => m.via === 'declared_program')
    expect(declared.length).toBeGreaterThan(0)
  })

  it('does not hand that credit to an unrelated source lane (evidence-based)', () => {
    const unrelated = { ...ECF_SOURCE_OPP, id: 'sba-x', source: 'sba_microloan', title: 'SBA Microloan Program' }
    const result = computeMatchDecision(ECF_MEMBER_PROFILE, unrelated, {
      profileSections: ECF_MEMBER_SECTIONS,
    })
    const matched = result.match_explain?.dataPointEvidence?.matched ?? []
    expect(matched.some((m) => m.via === 'declared_program')).toBe(false)
  })
})
