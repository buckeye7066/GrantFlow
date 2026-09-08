/**
 * A county-named award qualifies only for the profile that lives in that
 * county (owner rule 2026-09-07: "franklin county should not qualify, he does
 * not live in franklin county").
 *
 * "Franklin County Foundation Grant" left an Indiana senior's pipeline for the
 * wrong reason (a 501(c)(3) bullet). The gate must refuse it on GEOGRAPHY: he
 * lives in LaGrange County. Before this, a county-named award was only
 * downgraded when it resolved to another STATE; in-state or with no state at
 * all it passed.
 */
import { describe, it, expect } from 'vitest'
import { declaredAwardCounties, countyAwardMismatch, countyKey } from '../config/countyDeclaration.js'
import { isRelevantGeo } from '../config/fundingResultFilters.js'
import { gateQualifies, deriveProfileFacts } from '../services/robert/robertPipelineAudit.js'

const FRANKLIN_ROW = {
  title: 'Franklin County Foundation Grant',
  sponsor: 'The Foundation for Enhancing Communities',
  application_url: 'https://alpha.grantable.co/login?ref=apply&seed=grant%3Amopp_b06eb50d',
  source_url: 'https://grantable.co/funders/the-foundation-for-enhancing-communities-morg_4c86bfb2b0d143b4a6719ce03aa3309e',
  description: 'The Franklin County Community Foundation Grant supports innovative nonprofit projects in Franklin County.',
  eligibility_bullets: '["individuals and families in need"]',
  state: null,
  is_national: false,
}
const GENEMAC_BASIC = { city: 'Lagrange', email: 'mcnabbwg@yahoo.com', state: 'IN', county: 'La Grange', zip_code: '46761', full_name: 'GeneMac' }
const genemacFacts = () => deriveProfileFacts({ id: 'genemac', primary_type: 'senior' }, { basic_information: GENEMAC_BASIC }, { profileId: 'genemac' })

describe('a row that names itself after a county is a single-county award', () => {
  it('reads Franklin out of the title and treats "La Grange" and "LaGrange" as one county', () => {
    expect(declaredAwardCounties(FRANKLIN_ROW)).toEqual(['Franklin'])
    expect(countyKey('La Grange County, Indiana')).toBe('lagrange')
    expect(countyKey('LaGrange')).toBe('lagrange')
  })
  it('never reads a county SERVICE agency, a description mention, or a row with no award noun', () => {
    expect(declaredAwardCounties({ title: 'Bradley County Community Action Agency', sponsor: 'BCCAA' })).toEqual([])
    expect(declaredAwardCounties({ title: 'Emergency Assistance', description: 'serving Franklin County residents' })).toEqual([])
    expect(declaredAwardCounties({ title: 'Franklin County Health Department' })).toEqual([])
  })
  it('mismatch is decided against the profile county, and MISSING stays NEUTRAL', () => {
    expect(countyAwardMismatch(FRANKLIN_ROW, 'La Grange')).toMatchObject({ mismatch: true, declared: ['Franklin'] })
    expect(countyAwardMismatch(FRANKLIN_ROW, 'Franklin').mismatch).toBe(false)
    expect(countyAwardMismatch(FRANKLIN_ROW, null).mismatch).toBe(false)
    expect(countyAwardMismatch({ title: 'HealthWell Foundation' }, 'La Grange').mismatch).toBe(false)
  })
})

describe('QUALIFIES refuses a county-named award outside the profile county', () => {
  it('isRelevantGeo names the county in its refusal', () => {
    expect(isRelevantGeo(FRANKLIN_ROW, { states: ['IN'], county: 'La Grange' })).toMatchObject({ relevant: false, reason: 'declared_county_out_of_area:Franklin' })
    expect(isRelevantGeo(FRANKLIN_ROW, { states: ['IN'], county: 'Franklin' }).relevant).toBe(true)
    expect(isRelevantGeo(FRANKLIN_ROW, { states: ['IN'] }).relevant).toBe(true)
  })
  it('the audit facts carry a corroborated county anchor from the profile', () => {
    const facts = genemacFacts()
    expect(facts.countyAnchor).toMatchObject({ county: 'La Grange', state: 'IN', via: 'declared' })
  })
  it('gateQualifies refuses Franklin for GeneMac on geography, not on the applicant type', () => {
    const verdict = gateQualifies(FRANKLIN_ROW, genemacFacts())
    expect(verdict.pass).toBe(false)
    expect(verdict.evidence).toMatchObject({ gate: 'geo', detail: 'declared_county_out_of_area:Franklin' })
  })
  it('keeps a county-named award for the profile that lives there', () => {
    const franklinFacts = deriveProfileFacts({ id: 'p2', primary_type: 'senior' }, { basic_information: { ...GENEMAC_BASIC, county: 'Franklin', city: 'Brookville', zip_code: '47012' } }, { profileId: 'p2' })
    expect(gateQualifies(FRANKLIN_ROW, franklinFacts).pass).toBe(true)
  })
})
