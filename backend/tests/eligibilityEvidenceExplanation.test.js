/**
 * eligibility_evidence + honest ACCEPT explanations (2026-09-17).
 *
 * `eligible: true` on a canonical result is decision-derived ("ACCEPT") and has
 * never meant "eligibility was evaluated". Measured on the deployed catalog:
 * 41% of active ACCEPT rows sat on opportunities with NO eligibility text and
 * every one said "eligibility and location check out". Verdicts are untouched
 * here (silence is neutral, G4); what changes is that every result now states
 * how much eligibility evidence the engine had, and the explanation matches it.
 */
import { describe, it, expect } from 'vitest'
import {
  computeMatchDecision,
  eligibilityEvidenceLevel,
  locationStated,
  ELIGIBILITY_EVIDENCE,
} from '../services/matchEngine.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'
import { getSource } from '../crawler-os/sourceRegistry.js'
import { loadRegressionFixture, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

const fixture = loadRegressionFixture()

const BASE = {
  id: 'opp-evidence',
  title: 'Community Assistance Grant',
  description: 'Help with education costs.',
  sponsor: 'Example Foundation',
  application_url: 'https://example.org/apply',
}

describe('eligibilityEvidenceLevel', () => {
  it('prose: eligibility_text or bullets present', () => {
    expect(eligibilityEvidenceLevel({ ...BASE, eligibility_text: 'Must be enrolled full-time.' }, normalizeOpportunity({ ...BASE, eligibility_text: 'Must be enrolled full-time.' })))
      .toBe(ELIGIBILITY_EVIDENCE.PROSE)
    expect(eligibilityEvidenceLevel({ ...BASE, eligibility_bullets: ['Tennessee residents'] }, normalizeOpportunity({ ...BASE, eligibility_bullets: ['Tennessee residents'] })))
      .toBe(ELIGIBILITY_EVIDENCE.PROSE)
  })

  it('structured_flags: a restriction the normalizer derived from title/description, no prose', () => {
    const opp = { ...BASE, title: 'Veterans Housing Repair Grant', description: 'For veterans.' }
    expect(eligibilityEvidenceLevel(opp, normalizeOpportunity(opp))).toBe(ELIGIBILITY_EVIDENCE.STRUCTURED_FLAGS)
  })

  it('applicant_types_only: stated applicant types and nothing else', () => {
    const opp = { ...BASE, entity_types_allowed: ['individual'] }
    expect(eligibilityEvidenceLevel(opp, normalizeOpportunity(opp))).toBe(ELIGIBILITY_EVIDENCE.APPLICANT_TYPES_ONLY)
  })

  it('none: applicability unknown and no text', () => {
    const opp = { ...BASE }
    const norm = normalizeOpportunity(opp)
    expect(norm.applicabilityUnknown).toBe(true)
    expect(eligibilityEvidenceLevel(opp, norm)).toBe(ELIGIBILITY_EVIDENCE.NONE)
  })

  it('never throws on missing inputs', () => {
    expect(eligibilityEvidenceLevel(null, null)).toBe(ELIGIBILITY_EVIDENCE.NONE)
    expect(locationStated(null)).toBe(false)
  })
})

describe('the ACCEPT explanation claims only what was evaluated', () => {
  const { profile, sectionsByKey } = fixture

  it('captured rows: the claim tracks the evidence level and the stated location', () => {
    const stipend = computeMatchDecision(profile, fixture.opportunityById(CASE_IDS.ecfCaregiverStipend), { profileSections: sectionsByKey })
    expect(stipend.decision).toBe('ACCEPT')
    expect(stipend.eligibility_evidence).toBe(ELIGIBILITY_EVIDENCE.STRUCTURED_FLAGS)
    expect(stipend.explanation).toMatch(/Stated audience matches; detailed eligibility criteria are not published/)
    expect(stipend.explanation).toMatch(/Location checks out\./)

    const waivers = computeMatchDecision(profile, fixture.opportunityById(CASE_IDS.hcbsWaivers), { profileSections: sectionsByKey })
    expect(waivers.eligibility_evidence).toBe(ELIGIBILITY_EVIDENCE.APPLICANT_TYPES_ONLY)
    expect(waivers.explanation).toMatch(/Applicant type matches; eligibility criteria are not stated by the source/)

    const noGeo = computeMatchDecision(profile, fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo), { profileSections: sectionsByKey })
    expect(noGeo.eligibility_evidence).toBe(ELIGIBILITY_EVIDENCE.PROSE)
    expect(noGeo.explanation).toMatch(/Eligibility checks out\. Service area not stated by the source\./)
  })

  it('a REVIEW/REJECT result also carries eligibility_evidence (additive on every path)', () => {
    const parent = computeMatchDecision(profile, fixture.opportunityById(CASE_IDS.ecfParent), { profileSections: sectionsByKey })
    expect(parent.decision).toBe('REVIEW')
    expect(Object.values(ELIGIBILITY_EVIDENCE)).toContain(parent.eligibility_evidence)
    expect(parent.match_explain.eligibility_evidence).toBe(parent.eligibility_evidence)
  })
})

describe('ECF CHOICES child rows inherit the program page\'s stated population', () => {
  const { profile, sectionsByKey } = fixture

  it('with the parent statement as eligibility_text, the child row is held at REVIEW for a profile with no named condition — like the parent', () => {
    const source = getSource('tn_ecf_choices')
    expect(typeof source.resource_summary).toBe('string')
    const child = {
      ...fixture.opportunityById(CASE_IDS.ecfCaregiverStipend),
      eligibility_text: source.resource_summary,
    }
    const decision = computeMatchDecision(profile, child, { profileSections: sectionsByKey })
    expect(decision.eligibility_evidence).toBe(ELIGIBILITY_EVIDENCE.PROSE)
    expect(decision.decision).toBe('REVIEW')
    expect(decision.missingEligibilityFields).toContain('condition_specific_condition_not_named')
  })
})
