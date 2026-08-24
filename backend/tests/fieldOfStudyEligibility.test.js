import { describe, it, expect } from 'vitest'
import {
  FIELD_CLASSES,
  FIELD_DECLARATION_LIKE_PATTERNS,
  detectRequiredField,
  declaredProfileFields,
  fieldOfStudyConflict,
} from '../config/fieldOfStudyEligibility.js'

// The real prod case (2026-08-23): Robert Michael White declares
// education.intended_major = "Paramedic" / student_portal_plan.major = "Paramedic".
const PARAMEDIC = {
  education: { intended_major: 'Paramedic' },
  student_portal_plan: { major: 'Paramedic', career_goal: 'Critical Care Paramedic' },
}
const NURSING_STUDENT = { education: { intended_major: 'Nursing' } }
const NO_MAJOR = { education: {}, basic_information: {} }

// The real award: the ONLY field signal is in the title; every eligibility
// column is empty (verified in prod).
const NURSING_SCHOLARSHIP = {
  title: 'Marybelle Huggins Memorial Nursing Scholarship',
  sponsor: 'Lee Cockrell',
  eligibility_text: null,
  eligibility_bullets: [],
  categories: [],
  description: 'This scholarship aims to honor the memory of Marybelle Huggins by supporting students who share her passion for nursing.',
}

describe('field-of-study eligibility gate', () => {
  it('BARS the real case: a Nursing scholarship for a Paramedic major', () => {
    const c = fieldOfStudyConflict(PARAMEDIC, NURSING_SCHOLARSHIP)
    expect(c).toBeTruthy()
    expect(c.classId).toBe('nursing')
    expect(c.reason).toMatch(/nursing/i)
    expect(c.reason).toMatch(/paramedic/i)
  })

  it('KEEPS a Nursing scholarship for a Nursing student (exact field match)', () => {
    expect(fieldOfStudyConflict(NURSING_STUDENT, NURSING_SCHOLARSHIP)).toBeNull()
  })

  it('KEEPS when the profile declares no recognised major (silence on profile side)', () => {
    expect(fieldOfStudyConflict(NO_MAJOR, NURSING_SCHOLARSHIP)).toBeNull()
  })

  it('KEEPS when the award names no specific field (silence on award side)', () => {
    const generic = { title: 'Marybelle Huggins Memorial Scholarship', sponsor: 'Lee Cockrell' }
    expect(fieldOfStudyConflict(PARAMEDIC, generic)).toBeNull()
  })

  it('KEEPS a BROAD award ("Healthcare Scholarship") — a category is not a class', () => {
    const broad = { title: 'Future Healthcare Leaders Scholarship', sponsor: 'X' }
    expect(fieldOfStudyConflict(PARAMEDIC, broad)).toBeNull()
    const stem = { title: 'STEM Excellence Scholarship', sponsor: 'X' }
    expect(fieldOfStudyConflict(PARAMEDIC, stem)).toBeNull()
  })

  it('BARS a clearly cross-field award (Engineering) for a Paramedic', () => {
    const eng = { title: 'Women in Engineering Scholarship', sponsor: 'X' }
    const c = fieldOfStudyConflict(PARAMEDIC, eng)
    expect(c).toBeTruthy()
    expect(c.classId).toBe('engineering')
  })

  it('does NOT read the field requirement from DESCRIPTION prose', () => {
    // "passion for nursing" lives only in description; title/sponsor name no field.
    const descOnly = {
      title: 'Community Impact Scholarship',
      sponsor: 'A Foundation',
      description: 'For students who share a passion for nursing and caregiving.',
    }
    expect(detectRequiredField(descOnly)).toBeNull()
    expect(fieldOfStudyConflict(PARAMEDIC, descOnly)).toBeNull()
  })

  it('does NOT fire when the award names TWO different fields (ambiguous)', () => {
    const ambiguous = { title: 'Nursing and Engineering Excellence Scholarship', sponsor: 'X' }
    expect(detectRequiredField(ambiguous)).toBeNull()
    expect(fieldOfStudyConflict(PARAMEDIC, ambiguous)).toBeNull()
  })

  it('honors negation ("nursing majors are not eligible" is not a nursing restriction)', () => {
    const negated = { title: 'General Scholarship — nursing majors are not eligible', sponsor: 'X' }
    // The nursing hit is negated, so no nursing REQUIREMENT is declared.
    expect(detectRequiredField(negated)).toBeNull()
  })

  it('reads the profile major through the structured registry only', () => {
    expect(declaredProfileFields(PARAMEDIC).has('paramedic_ems')).toBe(true)
    expect(declaredProfileFields(NURSING_STUDENT).has('nursing')).toBe(true)
    // Prose mentioning a field in a non-major section must NOT mint a major.
    const prose = { narrative: { primary_goal: 'We run a nursing home ministry' } }
    expect(declaredProfileFields(prose).size).toBe(0)
  })

  it('TOTALITY: every FIELD_CLASS has at least one covering LIKE pattern', () => {
    for (const cls of FIELD_CLASSES) {
      // A class is covered if at least one of its plain-word patterns appears as a LIKE.
      const covered = FIELD_DECLARATION_LIKE_PATTERNS.some((like) => {
        const core = like.replace(/%/g, '').toLowerCase()
        return cls.patterns.some((rx) => rx.test(core))
      })
      expect(covered, `FIELD_CLASS ${cls.id} has no covering LIKE pattern`).toBe(true)
    }
  })
})
