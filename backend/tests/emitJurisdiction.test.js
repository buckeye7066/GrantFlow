/**
 * emitJurisdiction.test.js — the geography/residency emitter's SCOPE contract.
 *
 * The hard part is not detecting the state/country (opportunityJurisdiction owns
 * that value detection) — it is deciding WHICH SCOPE the geographic fact belongs
 * to: an APPLICANT residency bar (can hard-reject) vs a SERVICE AREA the award
 * serves (soft geo) vs the FUNDER's foreign identity (about the sponsor, never a
 * bar). The bare `state` column alone is crawl provenance, not a claim. See
 * emitJurisdiction.js.
 */
import { describe, it, expect } from 'vitest'
import emitJurisdiction from '../config/sourceClaims/emitJurisdiction.js'
import { SCOPES } from '../config/sourceClaims/core.js'

/** Convenience: find the single claim of a given dimension (or undefined). */
function claimFor(opp, dimension) {
  const claims = emitJurisdiction(opp)
  expect(Array.isArray(claims)).toBe(true)
  return claims.find((c) => c.dimension === dimension)
}

describe('emitJurisdiction — scope contract', () => {
  it('"Ohio Residents Only Emergency Grant" is an OH APPLICANT residency bar', () => {
    const c = claimFor({ title: 'Ohio Residents Only Emergency Grant' }, 'residency')
    expect(c).toBeTruthy()
    expect(c.dimension).toBe('residency')
    expect(c.value).toBe('OH')
    expect(c.scope).toBe('applicant')
    expect(c.strength).toBe('explicit')
    // An applicant residency claim IS a hard-reject scope.
    expect(['applicant', 'beneficiary']).toContain(c.scope)
  })

  it('"Polk County, TN — Local assistance programs" is a TN SERVICE AREA, NOT residency', () => {
    const claims = emitJurisdiction({ title: 'Polk County, TN — Local assistance programs' })
    const c = claims.find((x) => x.dimension === 'jurisdiction')
    expect(c).toBeTruthy()
    expect(c.value).toBe('TN')
    expect(c.scope).toBe('service_area')
    // Crucially: this is NOT an applicant residency bar.
    expect(claims.some((x) => x.scope === 'applicant')).toBe(false)
    expect(claims.some((x) => x.dimension === 'residency')).toBe(false)
  })

  it('a bare state:"OH" column with no title place and no residency prose makes NO claim (provenance, not a claim)', () => {
    expect(emitJurisdiction({ title: 'General Education Grant', state: 'OH' })).toEqual([])
  })

  it('a citizensinformation.ie host is an IE SPONSOR claim (foreign funder identity)', () => {
    const c = claimFor(
      { title: 'Housing Adaptation Grant', url: 'https://www.citizensinformation.ie/en/housing/' },
      'jurisdiction',
    )
    expect(c).toBeTruthy()
    expect(c.value).toBe('IE')
    expect(c.scope).toBe('sponsor')
    // A sponsor claim must never be an applicant bar.
    expect(['applicant', 'beneficiary']).not.toContain(c.scope)
  })
})

describe('emitJurisdiction — additional scope cases', () => {
  it('"must reside in Tennessee" is a TN applicant residency bar', () => {
    const c = claimFor(
      { title: 'Emergency Aid', description: 'Applicants must reside in Tennessee to apply.' },
      'residency',
    )
    expect(c).toBeTruthy()
    expect(c.value).toBe('TN')
    expect(c.scope).toBe('applicant')
    expect(c.strength).toBe('explicit')
  })

  it('"open to TN residents" is a TN applicant residency bar', () => {
    const c = claimFor(
      { title: 'Local Grant', eligibility_text: 'Open to TN residents.' },
      'residency',
    )
    expect(c).toBeTruthy()
    expect(c.value).toBe('TN')
    expect(c.scope).toBe('applicant')
  })

  it('a residency requirement supersedes the title service-area (no double geo claim)', () => {
    // The residency bar is the governing geographic fact; a service_area claim is
    // not also emitted for the same row.
    const claims = emitJurisdiction({
      title: 'Ohio Residents Only Emergency Grant',
      description: 'Ohio residents only.',
    })
    expect(claims.some((c) => c.scope === 'applicant')).toBe(true)
    expect(claims.some((c) => c.scope === 'service_area')).toBe(false)
  })

  it('a registered foreign-funder host (energysavinggrants.org) is a GB sponsor claim', () => {
    // A foreign funder on a generic .org TLD: the ccTLD rule is blind to it, so
    // the reused FOREIGN_FUNDER_HOSTS registry supplies the ISO country code.
    const c = claimFor(
      { title: 'Energy Saving Grant', source_url: 'https://energysavinggrants.org/apply' },
      'jurisdiction',
    )
    expect(c).toBeTruthy()
    expect(c.value).toBe('GB')
    expect(c.scope).toBe('sponsor')
  })

  it('every emitted claim carries a valid scope and non-empty evidence', () => {
    const opps = [
      { title: 'Ohio Residents Only Emergency Grant' },
      { title: 'Polk County, TN — Local assistance programs' },
      { title: 'Housing Adaptation Grant', url: 'https://www.citizensinformation.ie/en/' },
    ]
    for (const opp of opps) {
      const claims = emitJurisdiction(opp)
      expect(claims.length).toBeGreaterThan(0)
      for (const c of claims) {
        expect(SCOPES).toContain(c.scope)
        expect(c.evidence).toBeTruthy()
        expect(typeof c.evidence.field).toBe('string')
        expect(c.evidence.text.length).toBeGreaterThan(0)
      }
    }
  })

  it('returns [] for an empty / non-object opportunity', () => {
    expect(emitJurisdiction()).toEqual([])
    expect(emitJurisdiction({})).toEqual([])
    expect(emitJurisdiction(null)).toEqual([])
  })
})
