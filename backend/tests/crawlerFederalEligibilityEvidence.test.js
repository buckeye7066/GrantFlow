import { describe, expect, it } from 'vitest'
import { runDiscovery, createMemoryStore } from '../crawler-os/index.js'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { hasPositiveFourTruthProof, refreshFourTruthProof } from '../crawler-os/fundingTruthPolicy.js'
import { enrichGrantsGovCandidate } from '../crawler-os/adapters/grantsGovDetail.js'
import { buildLivePageFactColumns } from '../crawler-os/pageFacts.js'
import { evaluateApplicantTypeEligibility } from '../services/applicantTypeGate.js'

const SEARCH = 'https://api.grants.gov/v1/api/search2'
const DETAIL = 'https://api.grants.gov/v1/api/fetchOpportunity'

async function discover({ type = 'school_district', detailTypes = [{ id: '05', description: 'Independent school districts' }], detailStatus = 200, detailId = 363825, costSharing = false, instrument = 'Grant', sectionOverrides = {} } = {}) {
  const profile = { id: 'federal-evidence-fixture', primary_type: type, state: 'FL', needs: ['education'] }
  const sections = {
    basic_information: { profile_category: type, state: 'FL' },
    programs_services: { focus_areas: ['education'], interests: ['classroom supplies'] },
    narrative: { primary_goal: 'Education funding for classroom supplies.' },
    ...sectionOverrides,
  }
  const thesis = { profile_id: profile.id, applicant_types: ['school'], needs: ['education'], needs_defaulted: false, location: { state: 'FL' } }
  Object.defineProperty(thesis, '_profileContext', { value: { profile, sections, signals: buildProfileSignals({ profile, sections }) } })
  const calls = []
  const fetcher = { async fetch(url, init) {
    calls.push({ url, body: JSON.parse(init.body) })
    const isDetail = url === DETAIL
    const body = isDetail ? { errorcode: 0, data: {
      id: detailId, opportunityNumber: 'ED-FIXTURE', opportunityTitle: 'Classroom Education Award',
      synopsis: {
        opportunityId: detailId, synopsisDesc: 'Funds classroom supplies and education projects.',
        applicantTypes: detailTypes, costSharing,
        fundingInstruments: [{ description: instrument }],
        responseDateStr: '2099-11-10-00-00-00', awardFloor: '1000', awardCeiling: '5000',
      },
    } } : { data: { oppHits: [{ id: 363825, number: 'ED-FIXTURE', title: 'University Classroom Education Award', agency: 'Department of Education', closeDate: '11/10/2099', oppStatus: 'posted' }] } }
    return { ok: !isDetail || detailStatus === 200, status: isDetail ? detailStatus : 200, body: JSON.stringify(body), finalUrl: url, contentHash: isDetail ? 'detail-hash' : 'search-hash', fetchedAt: '2026-09-09T16:00:00Z' }
  } }
  const store = createMemoryStore()
  const run = await runDiscovery({ store, fetcher }, { thesis, matchProfiles: [thesis], onlySourceIds: ['grants_gov'] })
  return { run, calls, ops: store.all('funding_opportunities'), matches: store.all('profile_opportunity_matches') }
}

describe('federal crawler qualifications come from the award detail', () => {
  it('fetches the detail once across repeated search hits and preserves its actual eligibility and award figures', async () => {
    const result = await discover()
    expect(result.calls.filter(c => c.url === DETAIL)).toHaveLength(1)
    expect(result.calls.find(c => c.url === DETAIL).body).toEqual({ opportunityId: 363825 })
    expect(result.ops[0]).toMatchObject({ summary: 'Funds classroom supplies and education projects.', amount_min: 1000, amount_max: 5000, evidence_url: DETAIL, content_hash: 'detail-hash' })
    expect(JSON.parse(result.ops[0].eligibility_bullets_json)).toContain('Independent school districts')
    expect(result.run.recommendations).toHaveLength(1)
    expect(hasPositiveFourTruthProof(result.run.recommendations[0])).toBe(true)
  })

  it('does not turn a university title or source-wide taxonomy into qualification when details fail', async () => {
    const result = await discover({ detailStatus: 503 })
    expect(result.ops).toHaveLength(1)
    expect(JSON.parse(result.ops[0].applicant_types_json)).toEqual([])
    expect(result.run.recommendations).toEqual([])
    expect(result.matches.every(m => !hasPositiveFourTruthProof(m))).toBe(true)
  })

  it('does not use a different opportunity response as evidence for this award', async () => {
    const result = await discover({ detailId: 999999 })
    expect(result.run.recommendations).toEqual([])
    expect(JSON.parse(result.ops[0].applicant_types_json)).toEqual([])
  })

  it('does not qualify a K-12 district for a higher-education-only award', async () => {
    const result = await discover({ detailTypes: [{ id: '06', description: 'Public and State controlled institutions of higher education' }] })
    expect(result.run.recommendations).toEqual([])
  })

  it('does not qualify a private school for a district-only award', async () => {
    const result = await discover({ type: 'private_school' })
    expect(result.run.recommendations).toEqual([])
  })

  it('preserves the district restriction through storage into the live applicant gate', async () => {
    const result = await discover()
    const live = buildLivePageFactColumns(result.ops[0])
    expect(live.field_provenance).toBeDefined()
    expect(JSON.parse(live.field_provenance).applicant_types).toMatchObject({
      value: ['Independent school districts'], allowed_codes: ['05'],
    })
    expect(evaluateApplicantTypeEligibility({ ...live, entity_types_allowed: ['school'] }, 'private_school').decision).toBe('review')
    expect(evaluateApplicantTypeEligibility({ ...live, entity_types_allowed: ['school'] }, 'school_district').decision).toBe('pass')
  })

  it('does not use an unknown additional-applicant category to widen a stated government restriction', async () => {
    const result = await discover({ detailTypes: [{ id: '01', description: 'County governments' }, { id: '25', description: 'Others (see additional eligibility)' }] })
    expect(result.run.recommendations).toEqual([])
  })

  it('recognizes the stated nonprofit identity when the source explicitly permits nonprofits', async () => {
    const result = await discover({ type: 'nonprofit', detailTypes: [{ id: '13', description: 'Nonprofits without 501(c)(3) status' }] })
    expect(result.run.recommendations).toHaveLength(1)
  })

  it('uses the canonical business facts in the full profile, including after storage', async () => {
    const sections = { small_business_details: { business_name: 'Fixture Research Company', naics_code: '541715' } }
    const result = await discover({ type: 'organization', detailTypes: [{ id: '23', description: 'Small businesses' }], sectionOverrides: sections })
    expect(result.run.recommendations).toHaveLength(1)
    const live = { ...buildLivePageFactColumns(result.ops[0]), entity_types_allowed: ['business'] }
    expect(evaluateApplicantTypeEligibility(live, 'organization', { profile: { primary_type: 'organization' }, sections }).decision).toBe('pass')
    expect(evaluateApplicantTypeEligibility(live, 'organization').decision).toBe('review')
  })

  it('honors the official structured cost-share requirement', async () => {
    const result = await discover({ costSharing: true })
    expect(result.run.recommendations).toEqual([])
  })

  it('refuses a source-declared loan even when the search title omits that fact', async () => {
    const result = await discover({ instrument: 'Loan' })
    expect(result.run.recommendations).toEqual([])
  })

  it('stops new detail requests when the run budget is exhausted', async () => {
    let now = 0
    let calls = 0
    const context = { cache: new Map(), deadlineMs: 60000, clock: () => now, fetcher: { async fetch() {
      calls += 1
      now = 60001
      return { ok: false, status: 503 }
    } } }
    await enrichGrantsGovCandidate({ raw: { external_id: 1 } }, context)
    const next = await enrichGrantsGovCandidate({ raw: { external_id: 2 } }, context)
    expect(calls).toBe(1)
    expect(next.reason).toBe('time_budget_exhausted')
  })

  it('refuses a historical proof supported only by Grants.gov search results, including after refresh', async () => {
    const { run } = await discover()
    const proof = structuredClone(run.recommendations[0].four_truth_proof)
    proof.real.evidence_url = SEARCH
    expect(hasPositiveFourTruthProof(proof)).toBe(false)
    const refreshed = refreshFourTruthProof(proof, {
      canonical: { decision: 'ACCEPT', score: 50, eligible: true, matchedNeeds: ['education'], match_explain: { matchedSignals: ['applicant_type'] } },
      opportunity: { applicant_types: ['school'] }, needsDefaulted: false,
    })
    expect(refreshed.profile_qualifies.passed).toBe(false)
    expect(hasPositiveFourTruthProof(refreshed)).toBe(false)
  })
})
