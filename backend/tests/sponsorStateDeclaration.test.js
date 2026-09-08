/**
 * A STATE AGENCY'S OWN NAME IS A CLAIM ABOUT ITSELF (2026-09-08).
 *
 * This file's existing doctrine: "a row whose own title/sponsor says Tennessee
 * makes a claim about ITSELF; a state column makes a claim about a CRAWL."
 * `declaredStateFromUrls` already applies it to the row's URLs. Its SPONSOR was
 * never read, so a state agency's programme with a NULL state column read as
 * nationwide and reached every state's profiles.
 *
 * MEASURED on prod 2026-09-08 over 29,139 active rows: 1,970 sponsors name a
 * state, 758 of those rows carry a NULL or contradicting state column, and 15
 * are currently SURFACED to profiles — including "Low Income Home Energy
 * Assistance Program" sponsored by the CALIFORNIA Department of Community
 * Services, stored state NULL and is_national TRUE.
 *
 * This SCOPES rows; it deletes nothing. A California profile still sees the
 * California programme — an Indiana one stops.
 */
import { describe, it, expect } from 'vitest'
import { declaredStateFromSponsorName } from '../config/stateTitleDeclaration.js'
import { declaredStateFromTitle } from '../config/opportunityJurisdiction.js'

describe('a state agency sponsor declares its own state', () => {
  it.each([
    ['California Department of Community Services and Development', 'CA'],
    ['Tennessee Department of Economic and Community Development', 'TN'],
    ['West Central Missouri Community Action Agency', 'MO'],
    ['Texas Education Agency', 'TX'],
    ['State of Tennessee', 'TN'],
    ['Indiana Housing and Community Development Authority', 'IN'],
  ])('%s -> %s', (sponsor, expected) => {
    expect(declaredStateFromSponsorName({ sponsor })).toBe(expected)
  })

  // A GOVERNMENTAL word is required precisely so a national company whose brand
  // contains a place name is never mistaken for that state's agency.
  it.each([
    ['New York Life Foundation'],
    ['Texas Roadhouse Community Fund'],
    ['Georgia-Pacific Foundation'],
    ['Bank of America Charitable Foundation'],
  ])('%s is NOT read as a state agency', (sponsor) => {
    expect(declaredStateFromSponsorName({ sponsor })).toBeNull()
  })

  it('needs a FULL state name — a two-letter code is a coincidence magnet', () => {
    expect(declaredStateFromSponsorName({ sponsor: 'IN Department of Health' })).toBeNull()
    expect(declaredStateFromSponsorName({ sponsor: 'CA Housing Authority' })).toBeNull()
  })

  it('never guesses from a missing or non-governmental sponsor', () => {
    expect(declaredStateFromSponsorName({ sponsor: '' })).toBeNull()
    expect(declaredStateFromSponsorName({})).toBeNull()
    expect(declaredStateFromSponsorName(null)).toBeNull()
    expect(declaredStateFromSponsorName({ sponsor: 'Habitat for Humanity' })).toBeNull()
  })

  // "West Virginia" must never be read as Virginia — longest names match first.
  it('does not mistake West Virginia for Virginia', () => {
    expect(declaredStateFromSponsorName({ sponsor: 'West Virginia Department of Education' })).toBe('WV')
  })

  it('the jurisdiction authority consults it, so every geography consumer benefits', () => {
    // A row whose title declares nothing and whose state column is NULL still
    // gets its real state from the funder's own name.
    expect(declaredStateFromTitle({
      title: 'Low Income Home Energy Assistance Program',
      sponsor: 'California Department of Community Services and Development',
    })).toBe('CA')
  })

  it('a title that already declares a state still wins — this is a FALLBACK', () => {
    expect(declaredStateFromTitle({
      title: 'Polk County, TN — Local assistance programs',
      sponsor: 'California Department of Community Services',
    })).toBe('TN')
  })
})

describe('a sovereign government names its own jurisdiction', () => {
  it('refuses a UK scheme reaching a US profile', async () => {
    const { detectForeignOpportunity } = await import('../config/opportunityJurisdiction.js')
    // Measured: "Warm Homes Plan" (sponsor "UK Government") was ACCEPTed at
    // score 25 for a 60+ homeowner in Lagrange, INDIANA.
    expect(detectForeignOpportunity({ title: 'Warm Homes Plan', sponsor: 'UK Government' }).foreign).toBe(true)
  })

  it('does not treat a US funder as foreign', async () => {
    const { detectForeignOpportunity } = await import('../config/opportunityJurisdiction.js')
    expect(detectForeignOpportunity({ title: 'LIHEAP', sponsor: 'U.S. Department of Health and Human Services' }).foreign).toBe(false)
  })
})
