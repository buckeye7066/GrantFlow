/**
 * The four gates read the ROW'S OWN words for its place and its applicant
 * (owner order 2026-09-07: "Make sure his pipeline, as with all pipelines,
 * follows our four gates").
 *
 * Robert's audit kept 8 of 9 rows on an Indiana senior's pipeline. Three of
 * them named their place or their applicant plainly, in fields no gate read:
 *   - "Emergency Rental Assistance" at
 *     help.sengov.com/posts/assistance-programs-madison-county-kentucky-and-richmond
 *   - "Emergency Assistance Fund" whose evidence is domore24delaware.org
 *   - "Legit Hardship Grants" at livingtricky.com/category/government-grants/
 *   - "Franklin County Foundation Grant" whose eligibility bullets read
 *     "registered 501(c)(3) nonprofit organization"
 * Every row's state column was NULL, so "missing is neutral" waved them all
 * through. These are the verbatim prod rows.
 */
import { describe, it, expect } from 'vitest'
import { declaredStateFromUrls } from '../config/stateTitleDeclaration.js'
import { resolvedUsOpportunityJurisdiction } from '../config/canonicalUsJurisdiction.js'
import { isRelevantGeo } from '../config/fundingResultFilters.js'
import { classifyLocatorKindFromUrl, LOCATOR_URL_LIKE_PREFILTERS } from '../services/sources/locatorUrlKind.js'
import { evaluateApplicantTypeEligibility, organizationAttributeBulletsBar } from '../services/applicantTypeGate.js'
import { gateQualifies, gateRelatable } from '../services/robert/robertPipelineAudit.js'

const KENTUCKY_ROW = {
  title: 'Emergency Rental Assistance',
  sponsor: 'United Ministries',
  funder: 'United Ministries',
  url: 'https://help.sengov.com/posts/assistance-programs-madison-county-kentucky-and-richmond',
  application_url: 'https://help.sengov.com/posts/assistance-programs-madison-county-kentucky-and-richmond',
  source_url: 'https://help.sengov.com/posts/assistance-programs-madison-county-kentucky-and-richmond',
  evidence_url: 'https://help.sengov.com/posts/assistance-programs-pensacola-and-escambia-county',
  description: 'Assists individuals and families with partial mortgage/rental assistance and utility bills.',
  state: null,
  is_national: false,
}
const DELAWARE_ROW = {
  title: 'Emergency Assistance Fund',
  sponsor: 'Network Connect',
  url: 'https://www.degives.org/orgs/network-connect',
  source_url: 'https://www.degives.org/orgs/network-connect',
  evidence_url: 'https://www.domore24delaware.org/fundraisers/network-connect',
  state: null,
  is_national: false,
}
const HOUSTON_BLOG_ROW = {
  title: 'Legit Hardship Grants',
  sponsor: "City of Houston's Housing and Community Development Department",
  url: 'https://livingtricky.com/category/government-grants/',
  application_url: 'https://livingtricky.com/category/government-grants/',
  source_url: 'https://livingtricky.com/category/government-grants/',
  evidence_url: 'https://livingtricky.com/legit-hardship-grants/',
  eligibility_bullets: '["low-income people","single moms"]',
  state: null,
  is_national: false,
}
const FRANKLIN_ROW = {
  title: 'Franklin County Foundation Grant',
  sponsor: 'The Foundation for Enhancing Communities',
  application_url: 'https://alpha.grantable.co/login?ref=apply&seed=grant%3Amopp_b06eb50d',
  source_url: 'https://grantable.co/funders/the-foundation-for-enhancing-communities-morg_4c86bfb2b0d143b4a6719ce03aa3309e',
  description: 'The Franklin County Community Foundation Grant supports innovative nonprofit projects in Franklin County.',
  eligibility_bullets: '["registered 501(c)(3) nonprofit organization","nonprofit organization as recognized by the IRS"]',
  state: null,
  is_national: false,
}
const PAF_ROW = {
  title: 'Patient Advocate Foundation Financial Aid',
  sponsor: 'Patient Advocate Foundation (PAF)',
  application_url: 'https://www.patientadvocate.org',
  source_url: 'https://www.patientadvocate.org',
  evidence_url: 'https://nonprofitpoint.com/charities-that-help-with-medical-bills/',
  is_national: true,
}

const SENIOR_IN = {
  profileId: 'genemac',
  profile: { id: 'genemac', primary_type: 'senior' },
  sections: { basic_information: { state: 'IN', city: 'Lagrange' } },
  applicantType: 'senior',
  states: ['IN'],
  needs: ['housing', 'health_medical', 'senior'],
}

describe('a state name in the row\'s own URL is a place declaration', () => {
  it('reads Kentucky out of the sengov slug and Delaware out of the evidence host', () => {
    expect(declaredStateFromUrls(KENTUCKY_ROW)).toBe('KY')
    expect(declaredStateFromUrls(DELAWARE_ROW)).toBe('DE')
  })
  it('never reads a two-letter code, "washington", or a state buried inside a longer word', () => {
    expect(declaredStateFromUrls({ url: 'https://example.org/ky-programs/in-2026' })).toBeNull()
    expect(declaredStateFromUrls({ url: 'https://washington.org/grants' })).toBeNull()
    expect(declaredStateFromUrls({ url: 'https://example.org/indianapolis-housing' })).toBeNull()
  })
  it('reads West Virginia as WV, never as Virginia', () => {
    expect(declaredStateFromUrls({ url: 'https://example.org/west-virginia-housing-fund' })).toBe('WV')
    expect(declaredStateFromUrls({ url: 'https://example.org/virginia-housing-fund' })).toBe('VA')
  })
  it('ranks below a title declaration and above the stored column, and never narrows a national program', () => {
    expect(resolvedUsOpportunityJurisdiction(KENTUCKY_ROW)).toMatchObject({ state: 'KY', source: 'declared_url' })
    expect(resolvedUsOpportunityJurisdiction({ ...KENTUCKY_ROW, title: 'Madison County, TN — Rental help' })).toMatchObject({ state: 'TN', source: 'declared_title' })
    expect(resolvedUsOpportunityJurisdiction({ ...KENTUCKY_ROW, is_national: true })).toMatchObject({ is_national: true, source: 'stored_national' })
  })
  it('QUALIFIES refuses the Kentucky and Delaware rows for an Indiana senior and keeps them for their own states', () => {
    expect(isRelevantGeo(KENTUCKY_ROW, { states: ['IN'] })).toMatchObject({ relevant: false, reason: 'declared_url_place_out_of_state:KY' })
    expect(isRelevantGeo(DELAWARE_ROW, { states: ['IN'] })).toMatchObject({ relevant: false, reason: 'declared_url_place_out_of_state:DE' })
    expect(isRelevantGeo(KENTUCKY_ROW, { states: ['KY'] }).relevant).toBe(true)
    expect(gateQualifies(KENTUCKY_ROW, SENIOR_IN).pass).toBe(false)
    expect(gateQualifies(DELAWARE_ROW, SENIOR_IN).pass).toBe(false)
    expect(gateQualifies(KENTUCKY_ROW, { ...SENIOR_IN, states: ['KY'], sections: { basic_information: { state: 'KY' } } }).pass).toBe(true)
  })
  it('MISSING stays NEUTRAL: a profile with no state loses nothing, a national row is untouched', () => {
    expect(isRelevantGeo(KENTUCKY_ROW, { states: [] }).relevant).toBe(true)
    expect(isRelevantGeo(PAF_ROW, { states: ['IN'] }).relevant).toBe(true)
    expect(gateQualifies(PAF_ROW, SENIOR_IN).pass).toBe(true)
  })
})

describe('a /category/ path is a listing, never an application', () => {
  it('classifies the livingtricky category index as a directory on any host', () => {
    expect(classifyLocatorKindFromUrl('https://livingtricky.com/category/government-grants/')).toMatchObject({ kind: 'directory', reason: 'category_index_path' })
    expect(classifyLocatorKindFromUrl('https://someblog.net/blog/tag/hardship/')).toMatchObject({ kind: 'directory' })
  })
  it('leaves a real post and a host-specific benefit rule alone', () => {
    expect(classifyLocatorKindFromUrl('https://livingtricky.com/legit-hardship-grants/')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.hud.gov/topics/rental_assistance')).toMatchObject({ kind: 'benefit' })
  })
  it('RELATABLE harvests-then-removes the category index', () => {
    const verdict = gateRelatable(HOUSTON_BLOG_ROW)
    expect(verdict.pass).toBe(false)
    expect(verdict.harvest_first).toBe(true)
  })
  it('the sweeps can discover such rows (SQL prefilter carries the path shapes)', () => {
    expect(LOCATOR_URL_LIKE_PREFILTERS).toContain('%/category/%')
    expect(LOCATOR_URL_LIKE_PREFILTERS).toContain('%/tag/%')
  })
})

describe('an organization-attribute eligibility bullet bars an individual', () => {
  it('reads "registered 501(c)(3) nonprofit organization" as institution-only', () => {
    expect(organizationAttributeBulletsBar(FRANKLIN_ROW)).toMatchObject({ bullet: 'registered 501(c)(3) nonprofit organization' })
    expect(evaluateApplicantTypeEligibility(FRANKLIN_ROW, 'senior')).toMatchObject({ decision: 'mismatch', reason: 'institution_only_bullets_exclude_individual' })
    expect(gateQualifies(FRANKLIN_ROW, SENIOR_IN).pass).toBe(false)
  })
  it('is bullets-only and stays neutral when any bullet names a person-shaped applicant', () => {
    expect(organizationAttributeBulletsBar(HOUSTON_BLOG_ROW)).toBeNull()
    expect(organizationAttributeBulletsBar({ eligibility_bullets: '["registered 501(c)(3) nonprofit organization","individuals in need"]' })).toBeNull()
    expect(organizationAttributeBulletsBar({ description: 'registered 501(c)(3) nonprofit organization' })).toBeNull()
  })
  it('never bars an organization applicant', () => {
    expect(evaluateApplicantTypeEligibility(FRANKLIN_ROW, 'nonprofit').decision).not.toBe('mismatch')
  })
})
