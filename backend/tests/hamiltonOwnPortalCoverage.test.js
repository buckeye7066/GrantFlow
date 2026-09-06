/**
 * A school scholarship covered by a VERIFIED-submitted General Application is
 * DONE, not a login to perform. Prod 2026-09-06: DREAM Scholarship (own page
 * mtsu.edu/scholarships, governed by the General Application that MTSU's portal
 * confirmed submitted on Aug 3) was rerouted to the scholarship portal and
 * parked 14 times on Microsoft's Authenticator MFA wall. This resolves it as
 * covered before any login — while never sweeping a FAFSA/state award or a
 * program with its own application system (own url not governed).
 */
import { describe, it, expect } from 'vitest'
import {
  tenantForOwnPortal,
  readVerifiedGeneralApplication,
  ownPortalCoverageDecision,
  resolveOwnPortalCoverage,
} from '../services/hamilton/hamiltonOwnPortalCoverage.js'

const mtsuPortal = (replaced_url) => ({
  institution: 'Middle Tennessee State University',
  portal_host: 'mtsu.scholarships.ngwebsolutions.com',
  replaced_url,
})
const SUBMITTED = { status: 'submitted', evidence: 'Thank you for your submission of the Middle Tennessee State University Scholarship Application(s).' }

describe('tenantForOwnPortal', () => {
  it('reads the tenant slug from the scholarship portal host', () => {
    expect(tenantForOwnPortal({ portal_host: 'mtsu.scholarships.ngwebsolutions.com' })).toBe('mtsu')
    expect(tenantForOwnPortal({ portal_host: 'clevelandstatecc.scholarships.ngwebsolutions.com' })).toBe('clevelandstatecc')
    expect(tenantForOwnPortal({})).toBeNull()
  })
})

describe('ownPortalCoverageDecision — the honest discriminator is the OWN url', () => {
  it('DREAM (own url mtsu.edu/scholarships) is covered', () => {
    const d = ownPortalCoverageDecision({ tenant: 'mtsu', ownUrl: 'https://mtsu.edu/scholarships', generalApplication: SUBMITTED })
    expect(d?.covered).toBe(true)
    expect(d.message).toMatch(/covered by it/)
    expect(d.evidence).toMatch(/Thank you for your submission/)
  })

  it.each([
    ['https://www.mtsu.edu/graduate/funding/', 'HOPE graduate — a graduate funding page, not a scholarships application'],
    ['https://mtsu.studioabroad.com/index.cfm?FuseAction=Abroad.ViewLink&Link_ID=x', 'Commitment — a study-abroad application system'],
    ['https://mtsu.edu/one-stop/', 'a generic school page'],
  ])('NOT covered: %s', (ownUrl) => {
    expect(ownPortalCoverageDecision({ tenant: 'mtsu', ownUrl, generalApplication: SUBMITTED })).toBeNull()
  })

  it('never covers without a verified submission', () => {
    expect(ownPortalCoverageDecision({ tenant: 'mtsu', ownUrl: 'https://mtsu.edu/scholarships', generalApplication: null })).toBeNull()
    expect(ownPortalCoverageDecision({ tenant: 'mtsu', ownUrl: 'https://mtsu.edu/scholarships', generalApplication: { status: 'submitted', evidence: '' } })).toBeNull()
    expect(ownPortalCoverageDecision({ tenant: 'mtsu', ownUrl: 'https://mtsu.edu/scholarships', generalApplication: { status: 'no_open_applications', evidence: 'x' } })).toBeNull()
  })

  it('never covers a wrong-tenant url', () => {
    expect(ownPortalCoverageDecision({ tenant: 'clevelandstatecc', ownUrl: 'https://mtsu.edu/scholarships', generalApplication: SUBMITTED })).toBeNull()
  })
})

function fakeDb(row) {
  return { prepare: () => ({ get: async () => row }) }
}

describe('readVerifiedGeneralApplication — a portal-verified complete row only', () => {
  it('reads a portal-verified complete submission', async () => {
    const g = await readVerifiedGeneralApplication(fakeDb({ status: 'complete', source: 'portal_verified_read', evidence: SUBMITTED.evidence }), { profileId: 'p', portalHost: 'mtsu.scholarships.ngwebsolutions.com' })
    expect(g).toEqual({ status: 'submitted', evidence: SUBMITTED.evidence })
  })

  it('rejects complete-without-evidence, non-complete, and non-portal sources', async () => {
    expect(await readVerifiedGeneralApplication(fakeDb({ status: 'complete', source: 'portal_verified_read', evidence: '' }), { profileId: 'p', portalHost: 'h' })).toBeNull()
    expect(await readVerifiedGeneralApplication(fakeDb({ status: 'unmerged', source: 'portal_verified_read', evidence: 'x' }), { profileId: 'p', portalHost: 'h' })).toBeNull()
    expect(await readVerifiedGeneralApplication(fakeDb({ status: 'complete', source: 'admin_manual', evidence: 'x' }), { profileId: 'p', portalHost: 'h' })).toBeNull()
    expect(await readVerifiedGeneralApplication(fakeDb(null), { profileId: 'p', portalHost: 'h' })).toBeNull()
  })
})

describe('resolveOwnPortalCoverage — db-backed, end to end', () => {
  const db = fakeDb({ status: 'complete', source: 'portal_verified_read', evidence: SUBMITTED.evidence })

  it('covers DREAM, refuses HOPE-graduate and Commitment', async () => {
    expect((await resolveOwnPortalCoverage(db, { profileId: 'p', ownPortal: mtsuPortal('https://mtsu.edu/scholarships') }))?.covered).toBe(true)
    expect(await resolveOwnPortalCoverage(db, { profileId: 'p', ownPortal: mtsuPortal('https://www.mtsu.edu/graduate/funding/') })).toBeNull()
    expect(await resolveOwnPortalCoverage(db, { profileId: 'p', ownPortal: mtsuPortal('https://mtsu.studioabroad.com/index.cfm?Link_ID=x') })).toBeNull()
  })

  it('no coverage when the portal has no verified submission', async () => {
    const dbNo = fakeDb(null)
    expect(await resolveOwnPortalCoverage(dbNo, { profileId: 'p', ownPortal: mtsuPortal('https://mtsu.edu/scholarships') })).toBeNull()
  })
})
