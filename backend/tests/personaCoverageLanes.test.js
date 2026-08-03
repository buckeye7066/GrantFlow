/**
 * personaCoverageLanes.test.js
 *
 * The persona coverage audit (2026-08-02). Four real applicant situations the
 * owner named were run END TO END through the real planner and the real
 * discovery path, and three of the four had NO source lane at all:
 *
 *   - a homeowner in foreclosure: zero registry occurrences of foreclos*,
 *     mortgage, HAF, or housing counseling;
 *   - a renter facing eviction: zero occurrences of eviction, ERAP, rental
 *     assistance, or legal aid;
 *   - a struggling congregation: `church`/`ministry` were applicant_types on
 *     four unrelated rows and nothing else — no sacred-places, denominational,
 *     or preservation source.
 *
 * These tests pin the lanes that closed those gaps, and — more importantly —
 * pin the SHAPE that keeps them from flooding. Every assertion here fails on
 * pre-fix code.
 */
import { describe, it, expect } from 'vitest'
import { allSources, getSource, STATE_HOUSING_AGENCY_SOURCE_ID, STATE_HOUSING_AGENCY_STATES } from '../crawler-os/sourceRegistry.js'
import { getAdapter } from '../crawler-os/adapters/index.js'
import { plan } from '../crawler-os/planner.js'
import { LANE_OF_SOURCE, laneForSource } from '../services/coverageEvidenceService.js'
import { resolveStateHousingAgency } from '../crawler-os/adapters/stateHousingAgencyAdapter.js'
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js'
import { OPPORTUNITY_KIND } from '../crawler-os/contract.js'

const HOUSING_LOSS_LANE = ['hud_avoiding_foreclosure', 'cfpb_rent_and_housing_help', 'lawhelp_legal_aid', STATE_HOUSING_AGENCY_SOURCE_ID]
const CONGREGATION_LANE = ['national_fund_sacred_places', 'partners_sacred_places', 'nthp_preservation_grants']
const NEW_SOURCE_IDS = [...HOUSING_LOSS_LANE, ...CONGREGATION_LANE, 'va_veteran_benefits']

/** A profile-shaped thesis, the way buildThesis emits one. */
function thesisFor({ applicant_types, needs, state = null, county = null }) {
  return { applicant_types, needs, keywords: [...needs, ...applicant_types], location: { state, county } }
}

const FORECLOSURE = thesisFor({ applicant_types: ['individual'], needs: ['housing', 'legal', 'emergency'], state: 'IN', county: 'Howard' })
const EVICTION = thesisFor({ applicant_types: ['individual'], needs: ['housing', 'legal', 'emergency'], state: 'OH', county: 'Montgomery' })
const CONGREGATION = thesisFor({ applicant_types: ['church', 'nonprofit'], needs: ['capital', 'operations', 'programs'], state: 'OH', county: 'Erie' })

describe('persona coverage — the new lanes exist and are wired through every consumer', () => {
  it('every new source is in the registry, has an adapter, and has a lane', () => {
    for (const id of NEW_SOURCE_IDS) {
      const src = getSource(id)
      expect(src, `${id} missing from sourceRegistry`).toBeTruthy()
      expect(src.base_url, `${id} has no https base_url`).toMatch(/^https:\/\//)
      expect(getAdapter(id), `${id} has no adapter factory — the pipeline would report SKIPPED(no_adapter)`).toBeTruthy()
      expect(LANE_OF_SOURCE[id], `${id} missing from LANE_OF_SOURCE`).toBeTruthy()
      expect(laneForSource(id, src)).toBe(LANE_OF_SOURCE[id])
    }
  })

  it('a directory row declares the DIRECTORY kind and a grant row declares an honest award kind', () => {
    for (const id of NEW_SOURCE_IDS) {
      const src = getSource(id)
      if (src.directory) {
        expect(src.default_kinds, `${id} is directory:true so it must declare DIRECTORY`).toContain(OPPORTUNITY_KIND.DIRECTORY)
      } else {
        expect(src.default_kinds?.[0], `${id} is not a directory — it must declare a real award kind`).not.toBe(OPPORTUNITY_KIND.DIRECTORY)
      }
    }
  })

  it('a homeowner in foreclosure now selects the housing-loss lane (it selected NONE of it before)', () => {
    const selected = new Set(plan(FORECLOSURE).selected_source_ids)
    for (const id of HOUSING_LOSS_LANE) expect(selected.has(id), `${id} not selected for a foreclosure profile`).toBe(true)
  })

  it('a renter facing eviction now selects the housing-loss lane', () => {
    const selected = new Set(plan(EVICTION).selected_source_ids)
    for (const id of HOUSING_LOSS_LANE) expect(selected.has(id), `${id} not selected for an eviction profile`).toBe(true)
  })

  it('a congregation now selects the sacred-places lane, and an unrelated individual does NOT', () => {
    const church = new Set(plan(CONGREGATION).selected_source_ids)
    for (const id of CONGREGATION_LANE) expect(church.has(id), `${id} not selected for a congregation`).toBe(true)
    const renter = new Set(plan(EVICTION).selected_source_ids)
    for (const id of CONGREGATION_LANE) {
      expect(renter.has(id), `${id} leaked to a renter — the congregation lane must be applicant-scoped`).toBe(false)
    }
  })
})

describe('the state housing finance agency lane is ONE row, resolved per profile', () => {
  it('resolves the profile OWN state agency from STATE_REGISTRY, never a guess', () => {
    for (const st of ['IN', 'OH', 'WV']) {
      const got = resolveStateHousingAgency({ location: { state: st } })
      expect(got.state).toBe(st)
      expect(got.url).toBe(STATE_REGISTRY[st].housingUrl)
      expect(got.name).toBe(STATE_REGISTRY[st].housingName)
    }
  })

  it('a profile with NO state, or prod\'s junk "USA" state, resolves to nothing rather than a wrong state', () => {
    for (const loc of [{}, { state: null }, { state: '' }, { state: 'USA' }, { state: 'Indiana' }, { state: 'ZZ' }]) {
      const got = resolveStateHousingAgency({ location: loc })
      expect(got.state, `state ${JSON.stringify(loc)} must not resolve`).toBeNull()
      expect(got.url).toBeNull()
    }
  })

  it('THE FLOOD GUARD: the lane is a single NATIONAL row, so no profile can ever select more than one', () => {
    // The first build of this lane generated one state-scoped row per state,
    // mirroring STATE_BENEFITS_PORTALS. Measured against all 33 real prod
    // profiles it added +54 sources to the 5 profiles with no resolvable state,
    // because planner.servesGeo keeps a state-scoped source when the thesis has
    // no state. If anyone re-introduces per-state rows, this fails.
    const housingAgencyRows = allSources().filter((s) => /housing.?(finance.?)?agency/i.test(s.source_id))
    expect(housingAgencyRows.length, 'the state housing agency lane must be exactly ONE row').toBe(1)
    expect(housingAgencyRows[0].source_id).toBe(STATE_HOUSING_AGENCY_SOURCE_ID)
    expect(housingAgencyRows[0].geography?.national, 'the row must be national so servesGeo cannot multiply it').toBe(true)

    // And prove it directly: a state-less thesis selects exactly one.
    const stateless = thesisFor({ applicant_types: ['individual'], needs: ['housing'], state: null })
    const picked = plan(stateless).selected_source_ids.filter((id) => /housing.?(finance.?)?agency/i.test(id))
    expect(picked).toEqual([STATE_HOUSING_AGENCY_SOURCE_ID])
  })

  it('a MINTED per-state row DECLARES its state (the Robert White out-of-state-HFA class, 2026-08-03)', async () => {
    // The first version dropped the state the adapter had just resolved, so
    // every minted row ("West Virginia Housing Development Fund — …") entered
    // the catalog as `state NULL, is_national 1` — the state lived only in the
    // title as a FULL NAME — and cross-matched to every profile in the fleet
    // (prod 2026-08-03: 18 such rows, 333 match rows; a TN student surfaced
    // WV/IN/MI/AL/AR/OH agencies). FAILING-FIRST on the pre-fix adapter.
    const { createStateHousingAgencyAdapter } = await import('../crawler-os/adapters/stateHousingAgencyAdapter.js')
    const adapter = createStateHousingAgencyAdapter(STATE_HOUSING_AGENCY_SOURCE_ID)
    const source = allSources().find((s) => s.source_id === STATE_HOUSING_AGENCY_SOURCE_ID)

    const [req] = adapter.buildRequests({ location: { state: 'WV' } }, source, {})
    const candidate = req.parseCfg.directoryCandidate
    expect(candidate.geography).toEqual({ national: false, states: ['WV'] })
    const mapped = adapter.mapCandidate(candidate, { source })
    expect(mapped.geography).toEqual({ national: false, states: ['WV'] })

    // The UNRESOLVED generic fallback honestly stays national.
    const [fallbackReq] = adapter.buildRequests({ location: { state: 'USA' } }, source, {})
    const fallback = adapter.mapCandidate(fallbackReq.parseCfg.directoryCandidate, { source })
    expect(fallback.geography?.national).toBe(true)
  })

  it('the states list is READ from STATE_REGISTRY, never a hand-typed subset', () => {
    const expected = Object.keys(STATE_REGISTRY).filter((st) => STATE_REGISTRY[st]?.housingUrl).sort()
    expect(STATE_HOUSING_AGENCY_STATES).toEqual(expected)
    expect(STATE_HOUSING_AGENCY_STATES.length).toBeGreaterThanOrEqual(51)
  })
})

describe('the new rows do not flood the fleet', () => {
  // The registry-wide bound: each new row is gated by applicant type AND need,
  // so a profile that is neither an individual with a housing/legal need nor a
  // congregation picks up NOTHING. Measured on all 33 real prod profiles on
  // 2026-08-02: max +4 per profile, mean +3.48, zero profiles above +4.
  it('a research lab picks up none of the new rows', () => {
    const lab = thesisFor({ applicant_types: ['nonprofit'], needs: ['research'], state: 'CA' })
    const selected = new Set(plan(lab).selected_source_ids)
    for (const id of NEW_SOURCE_IDS) expect(selected.has(id), `${id} leaked to a research lab`).toBe(false)
  })

  it('no single profile shape can select more than 5 of the new rows', () => {
    // 4 is the bound MEASURED in prod today (25 of 33 profiles get exactly the
    // 4 housing-loss rows; 5 congregation-ish profiles get 3; 3 get none).
    // `va_veteran_benefits` fires on 0 of 33 because no prod thesis emits the
    // `veteran` applicant type — see the persona-coverage report. A veteran WITH
    // a housing need is the only shape that reaches 5, and only once that patch
    // lands, so the guard is 5 and it is still a hard ceiling.
    const shapes = [FORECLOSURE, EVICTION, CONGREGATION,
      thesisFor({ applicant_types: ['individual', 'veteran'], needs: ['housing', 'legal', 'emergency', 'veterans', 'startup'], state: 'WV' })]
    for (const t of shapes) {
      const n = plan(t).selected_source_ids.filter((id) => NEW_SOURCE_IDS.includes(id)).length
      expect(n, `a profile selected ${n} new rows — the ceiling is 5`).toBeLessThanOrEqual(5)
    }
    // The prod-measured shapes stay at 4.
    for (const t of [FORECLOSURE, EVICTION]) {
      expect(plan(t).selected_source_ids.filter((id) => NEW_SOURCE_IDS.includes(id)).length).toBe(4)
    }
  })
})
