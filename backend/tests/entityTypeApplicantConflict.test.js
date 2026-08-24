import { describe, it, expect } from 'vitest'
import emitEntityType from '../config/sourceClaims/emitEntityType.js'
import { entityTypeApplicantConflict } from '../config/sourceClaims/entityTypeApplicantConflict.js'

// Stage-2 slice-4: the entity-type twin of fieldOfStudyApplicantConflict. It
// fires ONLY on an APPLICANT-scoped entity_type claim (the STRUCTURED
// entity_types_allowed list), so an institutional word in the FUNDER's name or
// in prose no longer over-rejects an individual/family applicant.
const INDIVIDUAL = { basic_information: { profile_type: 'individual' } }
const BUSINESS = { basic_information: { profile_type: 'small_business' } }
const NONPROFIT = { basic_information: { profile_type: 'nonprofit' } }
const NO_TYPE = {}

describe('emitEntityType — scope of the entity word', () => {
  it('emits APPLICANT bars from the structured allow-list', () => {
    const claims = emitEntityType({ title: 'X', entity_types_allowed: ['nonprofit', 'school', 'government'] })
    const applicant = claims.filter((c) => c.scope === 'applicant')
    expect(applicant.length).toBeGreaterThan(0)
  })

  it('emits NO applicant bar when the allow-list is a wildcard', () => {
    const claims = emitEntityType({ title: 'X', entity_types_allowed: ['*'] })
    expect(claims.filter((c) => c.scope === 'applicant')).toHaveLength(0)
  })

  it('emits a SPONSOR claim (never an applicant bar) for an institutional word in the funder name', () => {
    const claims = emitEntityType({ title: 'Emergency Assistance', sponsor: 'Robert Wood Johnson Foundation' })
    expect(claims.filter((c) => c.scope === 'applicant')).toHaveLength(0)
    expect(claims.some((c) => c.scope === 'sponsor')).toBe(true)
  })
})

describe('entityTypeApplicantConflict — scope-aware entity-type gate', () => {
  it('REJECTS an institution-only award for an individual', () => {
    const c = entityTypeApplicantConflict(INDIVIDUAL, { title: 'Capacity Grant', entity_types_allowed: ['nonprofit', 'school', 'government'] })
    expect(c).toBeTruthy()
    expect(c.reason).toMatch(/entity type/i)
  })

  it('REDUCES over-rejection: an institutional word in the SPONSOR name does not reject an individual', () => {
    expect(
      entityTypeApplicantConflict(INDIVIDUAL, { title: 'Emergency Rent Assistance', sponsor: 'United Way Foundation' }),
    ).toBeNull()
  })

  it('KEEPS an award whose allow-list serves the profile bucket (business allowed / business profile)', () => {
    expect(
      entityTypeApplicantConflict(BUSINESS, { title: 'Growth Grant', entity_types_allowed: ['small_business', 'business'] }),
    ).toBeNull()
  })

  it('KEEPS a nonprofit-allowed award for a nonprofit profile', () => {
    expect(
      entityTypeApplicantConflict(NONPROFIT, { title: 'Capacity Grant', entity_types_allowed: ['nonprofit', 'school'] }),
    ).toBeNull()
  })

  it('is NEUTRAL on a wildcard allow-list', () => {
    expect(entityTypeApplicantConflict(INDIVIDUAL, { title: 'X', entity_types_allowed: ['*'] })).toBeNull()
  })

  it('is NEUTRAL when the profile type is unknown', () => {
    expect(entityTypeApplicantConflict(NO_TYPE, { title: 'X', entity_types_allowed: ['nonprofit'] })).toBeNull()
  })

  it('is NEUTRAL when the award states no structured allow-list', () => {
    expect(entityTypeApplicantConflict(INDIVIDUAL, { title: 'Community Grant' })).toBeNull()
  })
})
