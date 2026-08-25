import { describe, it, expect } from 'vitest'
import emitAcademicStage from '../config/sourceClaims/emitAcademicStage.js'
import { academicStageApplicantConflict } from '../config/sourceClaims/academicStageApplicantConflict.js'

// Stage-2 slice-4: the academic-stage twin of fieldOfStudyApplicantConflict. It
// fires ONLY on an APPLICANT-scoped stage claim, so a "School of Medicine"
// SPONSOR (an institution/awardee name) never hard-rejects, while a stated
// audience bar ("graduate students") does — against the stage the profile's
// DERIVED stage provably cannot occupy.
const HS_SENIOR = { basic_information: { academic_status: { education_level: 'High School Senior' } } }
const UNDERGRAD = { basic_information: { academic_status: { education_level: 'Undergraduate' } } }
const NO_STAGE = { basic_information: {} }

describe('emitAcademicStage — scope of the stage phrase', () => {
  it('emits an APPLICANT bar for a stated audience ("graduate students")', () => {
    const claims = emitAcademicStage({ title: 'Scholarship for Graduate Students in Biology' })
    expect(claims).toHaveLength(1)
    expect(claims[0].scope).toBe('applicant')
    expect(claims[0].value).toBe('graduate_or_professional')
  })

  it('emits an INSTITUTION claim for a "School of Medicine" SPONSOR (awardee, not audience)', () => {
    const claims = emitAcademicStage({ title: 'Annual Research Award', sponsor: 'Vanderbilt University, School of Medicine' })
    expect(claims).toHaveLength(1)
    expect(claims[0].scope).toBe('institution')
  })

  it('emits nothing when the row declares no stage', () => {
    expect(emitAcademicStage({ title: 'Community Impact Scholarship' })).toHaveLength(0)
  })
})

describe('academicStageApplicantConflict — scope-aware stage gate', () => {
  it('REJECTS a graduate award for a high-school senior', () => {
    const c = academicStageApplicantConflict(HS_SENIOR, { title: 'Graduate Fellowship in Chemistry' })
    expect(c).toBeTruthy()
    expect(c.classId).toBe('graduate_or_professional')
    expect(c.reason).toMatch(/graduate/i)
  })

  it('REJECTS a postdoctoral award for an undergraduate', () => {
    expect(
      academicStageApplicantConflict(UNDERGRAD, { title: 'Postdoctoral Research Fellowship' }),
    ).toBeTruthy()
  })

  it('WITHHOLDS on a "School of Medicine" SPONSOR (institution scope, not an applicant bar)', () => {
    expect(
      academicStageApplicantConflict(HS_SENIOR, { title: 'Annual Research Award', sponsor: 'Johns Hopkins University School of Medicine' }),
    ).toBeNull()
  })

  it('does NOT bar an undergraduate from a graduate award (a graduating senior applying to grad school is real)', () => {
    expect(
      academicStageApplicantConflict(UNDERGRAD, { title: 'Graduate Fellowship in Chemistry' }),
    ).toBeNull()
  })

  it('is NEUTRAL when the profile stage is unknown', () => {
    expect(academicStageApplicantConflict(NO_STAGE, { title: 'Graduate Fellowship in Chemistry' })).toBeNull()
  })

  it('is NEUTRAL when the award declares no stage', () => {
    expect(academicStageApplicantConflict(HS_SENIOR, { title: 'Community Impact Scholarship' })).toBeNull()
  })

  it('is NEUTRAL for an empty / missing opportunity', () => {
    expect(academicStageApplicantConflict(HS_SENIOR, {})).toBeNull()
    expect(academicStageApplicantConflict(HS_SENIOR)).toBeNull()
  })
})
