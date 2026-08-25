/**
 * geographyConflict.test.js — the SCOPE-AWARE geography gate (Stage-2 evidence
 * model). Geography is applicant-exclusive on BOTH residency AND service_area, so
 * it is not a field/profession-style single-scope drop-in.
 *
 * The module + its makeDecision wiring are asserted here:
 *   • a residency/applicant bar REJECTS an out-of-state profile,
 *   • a declared service_area REJECTS an out-of-state profile,
 *   • a bare crawl-provenance `state` column NO LONGER hard-rejects,
 *   • MISSING = NEUTRAL on either side,
 *   • a foreign sponsor row is NOT double-rejected by this gate.
 */
import { describe, it, expect } from 'vitest'
import {
  serviceAreaConflict,
  geographyConflict,
  declaredApplicantStates,
} from '../config/sourceClaims/geographyConflict.js'
import { makeDecision } from '../services/matchEngine.js'
import { ACCEPT_SCORE } from '../config/matchThresholds.js'

const TN_PROFILE = { basic_information: { state: 'TN' } }
const OH_PROFILE = { basic_information: { state: 'OH' } }
const NO_STATE_PROFILE = { basic_information: {} }

const TN_STATES = { profileStates: () => ['TN'] }
const OH_STATES = { profileStates: () => ['OH'] }
const NO_STATES = { profileStates: () => [] }

// A row that SERVES a place declares it in a "<Place>, ST —" title.
const SERVICE_AREA_TN = { title: 'Polk County, TN — Local assistance programs' }
// A row that requires RESIDENCY states it in prose.
const RESIDENCY_OH = { title: 'Emergency Grant', description: 'Ohio residents only.' }

describe('serviceAreaConflict — a served place is applicant-exclusive', () => {
  it('REJECTS an OH profile against a TN-service-area row', () => {
    const c = serviceAreaConflict(OH_PROFILE, SERVICE_AREA_TN, OH_STATES)
    expect(c).toBeTruthy()
    expect(c.servedState).toBe('TN')
    expect(c.scope).toBe('service_area')
    expect(c.reason).toMatch(/TN/)
  })

  it('KEEPS a TN profile against a TN-service-area row (in the served state)', () => {
    expect(serviceAreaConflict(TN_PROFILE, SERVICE_AREA_TN, TN_STATES)).toBeNull()
  })

  it('is NEUTRAL when the profile declares no state (silence, not a penalty)', () => {
    expect(serviceAreaConflict(NO_STATE_PROFILE, SERVICE_AREA_TN, NO_STATES)).toBeNull()
  })

  it('is NEUTRAL when the row declares no service area', () => {
    expect(
      serviceAreaConflict(OH_PROFILE, { title: 'National Housing Assistance' }, OH_STATES),
    ).toBeNull()
  })
})

describe('geographyConflict — combined residency + service_area, foreign ignored', () => {
  it('REJECTS on a residency/applicant mismatch (TN profile vs "Ohio residents only")', () => {
    const c = geographyConflict(TN_PROFILE, RESIDENCY_OH, TN_STATES)
    expect(c).toBeTruthy()
    expect(c.scope).toBe('residency')
  })

  it('REJECTS on a service_area mismatch (OH profile vs "Polk County, TN —")', () => {
    const c = geographyConflict(OH_PROFILE, SERVICE_AREA_TN, OH_STATES)
    expect(c).toBeTruthy()
    expect(c.scope).toBe('service_area')
  })

  it('does NOT reject a foreign-sponsor row — that is the foreign gate’s job (no double-reject)', () => {
    const c = geographyConflict(
      TN_PROFILE,
      { title: 'Housing Adaptation Grant', url: 'https://www.citizensinformation.ie/en/' },
      TN_STATES,
    )
    expect(c).toBeNull()
  })

  it('is NEUTRAL when the profile declares no state, even for an out-of-place row', () => {
    expect(geographyConflict(NO_STATE_PROFILE, RESIDENCY_OH, NO_STATES)).toBeNull()
    expect(geographyConflict(NO_STATE_PROFILE, SERVICE_AREA_TN, NO_STATES)).toBeNull()
  })

  it('is NEUTRAL for a row that declares no geography at all (bare state column is not a claim)', () => {
    expect(
      geographyConflict(
        TN_PROFILE,
        { title: 'Ohio Community Health Program', state: 'OH' },
        TN_STATES,
      ),
    ).toBeNull()
  })
})

describe('declaredApplicantStates — the row’s REAL evidenced geography', () => {
  it('collects a service_area state', () => {
    expect([...declaredApplicantStates(SERVICE_AREA_TN)]).toEqual(['TN'])
  })
  it('collects a residency/applicant state', () => {
    expect([...declaredApplicantStates(RESIDENCY_OH)]).toEqual(['OH'])
  })
  it('is EMPTY for a row whose only geography is the bare crawl-stamped column', () => {
    expect(declaredApplicantStates({ title: 'Ohio Community Health Program', state: 'OH' }).size).toBe(0)
  })
})

// ── makeDecision wiring ──────────────────────────────────────────────────────
// The engine's geo gate must (a) still reject genuine out-of-place residency /
// service-area rows, and (b) STOP hard-rejecting on the bare crawl-provenance
// `state` column — the "TN student got Cuyahoga Community College, Ohio" class.
const TN = { state: 'TN', primary_type: 'individual' }
const OK_URL = 'https://example.org/apply'

describe('makeDecision: scope-aware geography gate', () => {
  it('REJECTS a residency-exclusive out-of-state row', () => {
    const opp = { title: 'Ohio Emergency Aid', description: 'Ohio residents only.', state: 'OH', is_national: false, application_url: OK_URL }
    expect(makeDecision(ACCEPT_SCORE + 5, TN, opp).decision).toBe('REJECT')
  })

  it('REJECTS a declared service-area row for an out-of-state profile', () => {
    const opp = { title: 'Polk County, TN — Local assistance programs near you', is_national: false, application_url: OK_URL }
    expect(makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp).decision).toBe('REJECT')
  })

  it('KEEPS a declared service-area row for the served state', () => {
    const opp = { title: 'Polk County, TN — Local assistance programs near you', is_national: false, application_url: OK_URL }
    expect(makeDecision(ACCEPT_SCORE + 5, TN, opp).decision).toBe('ACCEPT')
  })

  it('CRAWL-PROVENANCE: a row whose residency prose names TN but whose `state` column was crawl-stamped OH is NOT rejected for a TN profile', () => {
    // OLD gate compared the "residents only" prose against the crawl-stamped OH
    // column and REJECTed a TN profile. NEW gate reads TN from the prose itself.
    const opp = {
      title: 'Cuyahoga Community College Foundation Scholarship',
      description: 'Tennessee residents only.',
      state: 'OH', // crawl provenance — stamped by an Ohio profile's run
      is_national: false,
      application_url: OK_URL,
    }
    const r = makeDecision(ACCEPT_SCORE + 5, TN, opp)
    expect(r.decision).not.toBe('REJECT')
    expect(r.decision).toBe('ACCEPT')
  })

  it('CRAWL-PROVENANCE (no claim): a bare crawl-stamped `state` column never hard-rejects — at most REVIEW', () => {
    const opp = { title: 'Ohio Community Health Program', description: 'Supports Ohio-area community health workers.', state: 'OH', is_national: false, application_url: OK_URL }
    const r = makeDecision(ACCEPT_SCORE + 5, TN, opp)
    expect(r.decision).not.toBe('REJECT')
  })

  it('MISSING = NEUTRAL: a stateless profile loses nothing on an out-of-place row', () => {
    const opp = { title: 'Polk County, TN — Local assistance programs near you', is_national: false, application_url: OK_URL }
    expect(makeDecision(ACCEPT_SCORE + 5, { primary_type: 'individual' }, opp).decision).toBe('ACCEPT')
  })
})
