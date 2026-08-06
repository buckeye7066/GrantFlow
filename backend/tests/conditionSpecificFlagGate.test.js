/**
 * A CONDITION-SPECIFIC program is never admitted or scored on a BARE
 * "Has disability" flag — the 2026-08-03 Demo Tennessee STEM Student audit.
 *
 * Her profile carries `demographics.disability_status = "Has disability"`
 * while her own health sections state "No confirmed medical conditions" — a
 * disability with NO NAMED CONDITION. Her 116 crawler matches nonetheless
 * carried a block of condition-specific programs: Brain Injury Association,
 * Autism Speaks, Arthritis Foundation, Amputee Coalition, Reeve Foundation
 * (paralysis), NORD, HLAA hearing aids. The planner-side lane gate
 * (`sourceServesDeclaredCondition`, 2026-08-02) had already closed the CRAWL
 * hole; this file guards the ENGINE hole:
 *
 *   - a NAMED matching condition keeps its boost and admission;
 *   - a bare/unnamed flag is NEUTRAL toward a condition-specific row — no
 *     disability-need score credit, at most a REVIEW, NEVER a new reject
 *     (these programs may still serve general disability);
 *   - no health signal at all keeps the PRE-EXISTING reject;
 *   - a NON-condition-specific disability program is completely untouched.
 *
 * Fixture titles are the audit's real programs; snippets are representative.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeOpportunity,
  normalizeProfile,
  computeMatchDecision,
  evaluateEligibility,
} from '../services/matchEngine.js'
import {
  namedProfileConditions,
  opportunityStatesCondition,
  conditionSpecificAlignment,
} from '../config/conditionSpecificity.js'

// ── The audit's real condition-specific programs ────────────────────────────
const AUDIT_PROGRAMS = [
  { key: 'autism', title: 'Autism Speaks — Family Support & Financial Assistance', description: 'Financial assistance and family support grants for individuals and families living with autism.' },
  { key: 'brain-injury', title: 'Brain Injury Association of America — Support Services', description: 'Support, resources and assistance programs for people living with brain injury.' },
  { key: 'arthritis', title: 'Arthritis Foundation — Help Line & Financial Assistance', description: 'Assistance resources for people living with arthritis.' },
  { key: 'amputee', title: 'Amputee Coalition — Limb Loss Support & Resources', description: 'Support and assistance for people living with limb loss and amputation.' },
  { key: 'reeve', title: 'Christopher & Dana Reeve Foundation — Paralysis Resource Center', description: 'Resources and assistance for people living with paralysis and spinal cord injury.' },
  { key: 'nord', title: 'National Organization for Rare Disorders (NORD) — Patient Assistance', description: 'Assistance programs for patients with a rare disease.' },
  { key: 'hlaa', title: 'Hearing Loss Association of America — Financial Assistance for Hearing Aids', description: 'Programs that help pay for hearing aids for people with hearing loss.' },
]

// The Reeve row declares a 'disability' need type, which is what the bare flag
// used to match against — the sharpest fixture for the score-credit assertions.
const REEVE = {
  id: 'reeve', is_national: 1,
  application_url: 'https://www.christopherreeve.org/todays-care/get-support/',
  title: 'Christopher & Dana Reeve Foundation — Paralysis Resource Center',
  description: 'Resources and assistance for people living with paralysis and spinal cord injury; support for people with a physical disability.',
}

const BASE_PROFILE = { id: 'p-demo_stem_student', primary_type: 'individual', state: 'TN' }

/** Sections for the three profile variants. */
const sectionsWith = ({ conditions = '', disabilityStatus = null, extraHealth = {} } = {}) => ({
  demographics: disabilityStatus ? { disability_status: disabilityStatus } : {},
  health_medical: { conditions, notes: conditions ? '' : 'No confirmed medical conditions', ...extraHealth },
  financial_information: { needs: ['education'] },
})

const BARE_SECTIONS = sectionsWith({ disabilityStatus: 'Has disability' })
const NONE_SECTIONS = sectionsWith({})
const namedSections = (condition) => sectionsWith({ conditions: condition, disabilityStatus: 'Has disability' })

describe('detection: the audit programs ARE condition-specific (A/B: pre-fix patterns missed all but NORD)', () => {
  it.each(AUDIT_PROGRAMS)('$key is detected as diseaseSpecific', (p) => {
    expect(normalizeOpportunity({ title: p.title, description: p.description }).diseaseSpecific).toBe(true)
  })

  it('a GENERAL disability program is NOT condition-specific', () => {
    const on = normalizeOpportunity({
      title: 'State Vocational Rehabilitation Services — Disability Employment Support',
      description: 'Employment support and assistance for people with disabilities. Accessible services and accommodation help.',
    })
    expect(on.diseaseSpecific).toBe(false)
  })
})

describe('named-condition extraction (the profile side)', () => {
  it('"No confirmed medical conditions" mints NO named condition — a denial is not a diagnosis', () => {
    const norm = normalizeProfile(BASE_PROFILE, BARE_SECTIONS, null)
    expect(namedProfileConditions(norm, null)).toEqual([])
  })

  it('a bare flag and generic category-of-person words never count as names', () => {
    const norm = normalizeProfile(BASE_PROFILE, sectionsWith({ conditions: 'physical disability', disabilityStatus: 'Has disability' }), null)
    // 'physical disability' is in GENERIC_HEALTH_DESCRIPTORS — a category of
    // person, not a condition; it must not claim the Reeve paralysis lane.
    expect(namedProfileConditions(norm, null)).toEqual([])
  })

  it('a real named condition survives, list-split and normalized', () => {
    const norm = normalizeProfile(BASE_PROFILE, sectionsWith({ conditions: 'Type 2 Diabetes; arthritis', disabilityStatus: 'Has disability' }), null)
    const named = namedProfileConditions(norm, null)
    expect(named).toContain('type 2 diabetes')
    expect(named).toContain('arthritis')
  })

  it('a canonical boolean diagnosis flag names its condition (hearing_impairment → HLAA)', () => {
    const norm = normalizeProfile(BASE_PROFILE, sectionsWith({ disabilityStatus: 'Has disability', extraHealth: { hearing_impairment: true } }), null)
    const named = namedProfileConditions(norm, null)
    expect(named).toContain('hearing impairment')
    expect(opportunityStatesCondition(
      'hearing loss association of america financial assistance for hearing aids',
      named,
    )).toBe('hearing impairment')
  })

  it('three-way alignment: named / unnamed / none', () => {
    const oppNorm = normalizeOpportunity({ title: AUDIT_PROGRAMS[0].title, description: AUDIT_PROGRAMS[0].description })
    const oppText = `${AUDIT_PROGRAMS[0].title} ${AUDIT_PROGRAMS[0].description}`.toLowerCase()
    const aligned = (sections) =>
      conditionSpecificAlignment({ profileNorm: normalizeProfile(BASE_PROFILE, sections, null), oppNorm, oppText })
    expect(aligned(namedSections('autism'))).toBe('named')
    expect(aligned(BARE_SECTIONS)).toBe('unnamed')
    expect(aligned(NONE_SECTIONS)).toBe('none')
    // Not condition-specific → the assessment stays out of the way entirely.
    expect(conditionSpecificAlignment({
      profileNorm: normalizeProfile(BASE_PROFILE, BARE_SECTIONS, null),
      oppNorm: { diseaseSpecific: false },
      oppText,
    })).toBeNull()
  })
})

describe('evaluateEligibility: three-way, never a new hard reject for the flag', () => {
  const oppNorm = normalizeOpportunity(REEVE)

  it('bare unnamed flag → MISSING field (review), not ineligibility', () => {
    const ev = evaluateEligibility(normalizeProfile(BASE_PROFILE, BARE_SECTIONS, null), oppNorm)
    expect(ev.missingFields).toContain('condition_specific_condition_not_named')
    expect(ev.ineligibilityReasons.join(' ')).not.toMatch(/specific medical condition/i)
  })

  it('a NAMED matching condition passes clean (boost kept)', () => {
    const ev = evaluateEligibility(normalizeProfile(BASE_PROFILE, namedSections('paralysis'), null), oppNorm)
    expect(ev.missingFields).not.toContain('condition_specific_condition_not_named')
    expect(ev.ineligibilityReasons.join(' ')).not.toMatch(/specific medical condition/i)
  })

  it('no health signal at all keeps the PRE-EXISTING ineligibility', () => {
    const ev = evaluateEligibility(normalizeProfile(BASE_PROFILE, NONE_SECTIONS, null), oppNorm)
    expect(ev.ineligibilityReasons.join(' ')).toMatch(/specific medical condition/i)
  })

  it('a research org stays exempt (the 2026-07-06 Axiom class)', () => {
    const researchNorm = normalizeProfile(
      { id: 'org1', primary_type: 'organization' },
      { organization_details: { organization_type: 'Biomedical Research Institute' } },
      null,
    )
    const ev = evaluateEligibility(researchNorm, oppNorm)
    expect(ev.ineligibilityReasons.join(' ')).not.toMatch(/specific medical condition/i)
    expect(ev.missingFields).not.toContain('condition_specific_condition_not_named')
  })
})

describe('computeMatchDecision: the flag buys no score and no ACCEPT — and never a new REJECT', () => {
  it('BARE flag vs Reeve: REVIEW at most, disability NOT in matchedNeeds, missing field surfaced (A/B: pre-fix this ACCEPTed with matchedNeeds [disability])', () => {
    const r = computeMatchDecision(BASE_PROFILE, REEVE, { profileSections: BARE_SECTIONS })
    expect(r.decision).not.toBe('ACCEPT')
    expect(r.decision).not.toBe('REJECT') // neutral, never a new reject
    expect(r.matchedNeeds).not.toContain('disability')
    expect(r.missingEligibilityFields).toContain('condition_specific_condition_not_named')
  })

  it('NAMED matching condition keeps the boost: disability need credited, no condition cap', () => {
    const named = computeMatchDecision(BASE_PROFILE, REEVE, { profileSections: namedSections('paralysis') })
    expect(named.matchedNeeds).toContain('disability')
    expect(named.missingEligibilityFields).not.toContain('condition_specific_condition_not_named')
    const bare = computeMatchDecision(BASE_PROFILE, REEVE, { profileSections: BARE_SECTIONS })
    // The named condition scores at least as well as the bare flag ever can.
    expect(named.score).toBeGreaterThanOrEqual(bare.score)
  })

  it('every audit program is held below ACCEPT for the bare-flag profile', () => {
    for (const p of AUDIT_PROGRAMS) {
      const opp = { id: p.key, title: p.title, description: p.description, application_url: 'https://example.org/apply', is_national: 1 }
      const r = computeMatchDecision(BASE_PROFILE, opp, { profileSections: BARE_SECTIONS })
      expect(r.decision, `${p.key} was ${r.decision}`).not.toBe('ACCEPT')
      expect(r.decision, `${p.key} was rejected — the flag must stay neutral, not negative`).not.toBe('REJECT')
      expect(r.matchedNeeds, `${p.key} credited the bare flag`).not.toContain('disability')
    }
  })

  it('NO health signal keeps the pre-existing REJECT (unchanged behavior)', () => {
    const r = computeMatchDecision(BASE_PROFILE, REEVE, { profileSections: NONE_SECTIONS })
    expect(r.decision).toBe('REJECT')
    expect(r.ineligibilityReasons.join(' ')).toMatch(/specific medical condition/i)
  })

  it('COUNTERWEIGHT: a general (non-condition-specific) disability program still credits the bare flag', () => {
    const generalOpp = {
      id: 'vr', is_national: 1, application_url: 'https://www.tn.gov/vr',
      title: 'State Vocational Rehabilitation Services — Disability Employment Support',
      description: 'Employment support and assistance for people with disabilities. Accessible services and accommodation help.',
    }
    const r = computeMatchDecision(BASE_PROFILE, generalOpp, { profileSections: BARE_SECTIONS })
    expect(r.decision).not.toBe('REJECT')
    expect(r.matchedNeeds).toContain('disability')
    expect(r.missingEligibilityFields).not.toContain('condition_specific_condition_not_named')
  })
})
