/**
 * residencyApplicantConflict.test.js — the SCOPE-AWARE residency gate, the
 * geography twin of fieldOfStudyApplicantConflict.
 *
 * It fires ONLY on an emitJurisdiction residency/applicant claim (an explicit
 * "Ohio Residents Only"-shaped bar). A jurisdiction/service_area claim ("Polk
 * County, TN — assistance") is a soft geo signal owned by matchEngine's geo tier
 * and must NOT hard-reject here; sponsor/foreign claims stay with the
 * foreign-jurisdiction gate. Both sides must be non-empty — silence is neutral.
 */
import { describe, it, expect } from 'vitest'
import {
  residencyApplicantConflict,
  residencyApplicantConflictFromSections,
  profileStatesFromSections,
} from '../config/sourceClaims/residencyApplicantConflict.js'

// Profiles whose declared home state buildProfileSignals resolves cleanly.
const TN_PROFILE = { basic_information: { state: 'TN' } }
const OH_PROFILE = { basic_information: { state: 'OH' } }
const NO_STATE_PROFILE = { basic_information: {} }

const TN_STATES = { profileStates: () => ['TN'] }
const OH_STATES = { profileStates: () => ['OH'] }
const NO_STATES = { profileStates: () => [] }

describe('residencyApplicantConflict — scope-aware residency gate', () => {
  it('REJECTS a TN profile against an "Ohio Residents Only" applicant bar', () => {
    const c = residencyApplicantConflict(
      TN_PROFILE,
      { title: 'Ohio Residents Only Emergency Grant' },
      TN_STATES,
    )
    expect(c).toBeTruthy()
    expect(c.requiredState).toBe('OH')
    expect(c.reason).toMatch(/OH/)
  })

  it('WITHHOLDS on a service_area row ("Polk County, TN — assistance") — not an applicant residency bar', () => {
    const c = residencyApplicantConflict(
      TN_PROFILE,
      { title: 'Polk County, TN — Local assistance programs' },
      TN_STATES,
    )
    expect(c).toBeNull()
  })

  it('KEEPS an OH profile against "Ohio Residents Only" (required state is among the profile states)', () => {
    const c = residencyApplicantConflict(
      OH_PROFILE,
      { title: 'Ohio Residents Only Emergency Grant' },
      OH_STATES,
    )
    expect(c).toBeNull()
  })

  it('is NEUTRAL when the award states no residency requirement', () => {
    expect(
      residencyApplicantConflict(TN_PROFILE, { title: 'General Education Grant' }, TN_STATES),
    ).toBeNull()
  })

  it('is NEUTRAL when the profile declares no state (silence, not a penalty)', () => {
    expect(
      residencyApplicantConflict(
        NO_STATE_PROFILE,
        { title: 'Ohio Residents Only Emergency Grant' },
        NO_STATES,
      ),
    ).toBeNull()
  })

  it('is NEUTRAL for a foreign sponsor claim (citizensinformation.ie) — out of scope for this gate', () => {
    expect(
      residencyApplicantConflict(
        TN_PROFILE,
        { title: 'Housing Adaptation Grant', url: 'https://www.citizensinformation.ie/en/' },
        TN_STATES,
      ),
    ).toBeNull()
  })
})

describe('residencyApplicantConflictFromSections — resolves profile states itself', () => {
  it('resolves a declared home state the way matchEngine does', () => {
    expect(profileStatesFromSections(TN_PROFILE)).toContain('TN')
    expect(profileStatesFromSections(NO_STATE_PROFILE)).toEqual([])
  })

  it('REJECTS a TN profile against "Ohio Residents Only" with no deps threaded', () => {
    const c = residencyApplicantConflictFromSections(TN_PROFILE, {
      title: 'Ohio Residents Only Emergency Grant',
    })
    expect(c).toBeTruthy()
    expect(c.requiredState).toBe('OH')
  })

  it('KEEPS an OH profile against "Ohio Residents Only"', () => {
    expect(
      residencyApplicantConflictFromSections(OH_PROFILE, {
        title: 'Ohio Residents Only Emergency Grant',
      }),
    ).toBeNull()
  })

  it('WITHHOLDS on a TN service_area row for a TN profile', () => {
    expect(
      residencyApplicantConflictFromSections(TN_PROFILE, {
        title: 'Polk County, TN — Local assistance programs',
      }),
    ).toBeNull()
  })

  it('is NEUTRAL when the profile declares no state', () => {
    expect(
      residencyApplicantConflictFromSections(NO_STATE_PROFILE, {
        title: 'Ohio Residents Only Emergency Grant',
      }),
    ).toBeNull()
  })
})
