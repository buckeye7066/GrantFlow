/**
 * Unit tests for the profession-lock eligibility predicate
 * (backend/services/eligibility/professionEligibility.js).
 *
 * The real-world case: a Tennessee PARAMEDIC student must NOT match nursing /
 * social-work profession-locked scholarships, but a nursing student SHOULD, and
 * a profile with no declared field must never be rejected (conservative).
 */
import { describe, it, expect } from 'vitest'
import {
  resolveProfileProfessions,
  professionSignalTextFromSections,
  detectOpportunityProfessionLock,
  opportunityLockText,
  assessProfessionEligibility,
} from '../services/eligibility/professionEligibility.js'

describe('professionSignalTextFromSections — curated fields only', () => {
  it('reads intended_major / career_goal, NOT free-text experience', () => {
    const sections = {
      education: { intended_major: 'Paramedic', current_institution: 'Cleveland State CC' },
      employment: {
        career_goal: 'Fully qualified Paramedic',
        experience: 'Over 400 hours in skilled nursing facilities', // must be ignored
      },
    }
    const text = professionSignalTextFromSections(sections)
    expect(text).toContain('paramedic')
    // The experience blurb mentioning "nursing" must NOT leak into the signal.
    expect(text).not.toContain('skilled nursing facilities')
    expect(text).not.toContain('nursing')
  })

  it('parses JSON-string section data', () => {
    const text = professionSignalTextFromSections({
      education: JSON.stringify({ field_of_study: 'Nursing (BSN)' }),
    })
    expect(text).toContain('nursing')
  })
})

describe('resolveProfileProfessions', () => {
  it('types a paramedic profile as emergency_medical (never nursing)', () => {
    const p = resolveProfileProfessions('fully qualified paramedic')
    expect(p.has('emergency_medical')).toBe(true)
    expect(p.has('nursing')).toBe(false)
  })
  it('types a nursing student as nursing', () => {
    const p = resolveProfileProfessions('bsn nursing student')
    expect(p.has('nursing')).toBe(true)
  })
  it('returns an empty set for an unknown/blank field', () => {
    expect(resolveProfileProfessions('').size).toBe(0)
    expect(resolveProfileProfessions('interested in helping people').size).toBe(0)
  })
})

describe('detectOpportunityProfessionLock — identity text only', () => {
  it('locks a "<State> Nurses Foundation" scholarship to nursing', () => {
    expect(detectOpportunityProfessionLock('Ohio Nurses Foundation — Continuing Education & Ethics Scholarships')).toBe('nursing')
  })
  it('locks NASW social-work CE to social_work', () => {
    expect(detectOpportunityProfessionLock('NASW Foundation — Social Work CE & Professional Development Funds')).toBe('social_work')
  })
  it('does NOT lock a general workforce fund whose TITLE names no profession', () => {
    // "WIOA Individual Training Accounts" can fund paramedic training too.
    expect(detectOpportunityProfessionLock('WIOA Individual Training Accounts — License Reinstatement & Remediation Tuition')).toBeNull()
    expect(detectOpportunityProfessionLock('TennCare CHOICES in Long-Term Services and Supports')).toBeNull()
  })
  it('does NOT lock a general scholarship', () => {
    expect(detectOpportunityProfessionLock('Coca-Cola Scholars Foundation')).toBeNull()
  })
})

describe('opportunityLockText — title + funder only (never description)', () => {
  it('joins title and funder/sponsor, ignores description/notes', () => {
    const t = opportunityLockText({ title: 'Ohio Nurses Foundation', funder: 'National Program', notes: 'covers paramedics too' })
    expect(t).toContain('Ohio Nurses Foundation')
    expect(t).not.toContain('paramedics')
  })
})

describe('assessProfessionEligibility — the decision', () => {
  const paramedic = resolveProfileProfessions('paramedic')

  it('REJECTS a nursing scholarship for a paramedic student', () => {
    const v = assessProfessionEligibility({
      itemText: opportunityLockText({ title: 'Ohio Nurses Foundation — CE Scholarships' }),
      professions: paramedic,
    })
    expect(v.ineligible).toBe(true)
    expect(v.lock).toBe('nursing')
  })

  it('KEEPS a nursing scholarship for a nursing student', () => {
    const v = assessProfessionEligibility({
      itemText: opportunityLockText({ title: 'Ohio Nurses Foundation — CE Scholarships' }),
      professions: resolveProfileProfessions('nursing bsn'),
    })
    expect(v.ineligible).toBe(false)
  })

  it('NEVER rejects when the profile field is unknown (conservative)', () => {
    const v = assessProfessionEligibility({
      itemText: opportunityLockText({ title: 'Ohio Nurses Foundation — CE Scholarships' }),
      professions: new Set(),
    })
    expect(v.ineligible).toBe(false)
    expect(v.reason).toBe('profile_field_unknown')
  })

  it('NEVER rejects a non-profession-locked opportunity', () => {
    const v = assessProfessionEligibility({
      itemText: opportunityLockText({ title: 'Coca-Cola Scholars Foundation' }),
      professions: paramedic,
    })
    expect(v.ineligible).toBe(false)
    expect(v.reason).toBe('not_profession_locked')
  })

  it('does not reject a general healthcare scholarship for a paramedic (no lock)', () => {
    const v = assessProfessionEligibility({
      itemText: opportunityLockText({ title: 'Healthcare Heroes Scholarship' }),
      professions: paramedic,
    })
    expect(v.ineligible).toBe(false)
  })
})
