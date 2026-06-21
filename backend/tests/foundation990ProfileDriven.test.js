/**
 * foundation990ProfileDriven.test.js
 *
 * Proves the Foundation 990 crawler is PROFILE-DRIVEN (GrantFlow goal:
 * "use the FULL profile"), not statically hardcoded to states=['nationwide'],
 * ntee=['T'].
 *
 *   (1) deriveStatesForProfile reads ALL of a profile's states (primary +
 *       secondary), not a hardcoded 'nationwide'.
 *   (2) deriveNteeCodesForProfile maps a faith/church profile → 'X' (religion),
 *       a student profile → 'B' (education), an EMS profile → 'M' (public safety).
 *   (3) processFoundation990Job (with a MOCKED ProPublica client) actually
 *       searches the DERIVED states/NTEE, scores results through the canonical
 *       matcher, and inserts only matched foundations.
 *   (4) With no profileContext it falls back to the historical admin defaults.
 *
 * Network is fully mocked via the `deps` test seam — no live ProPublica calls.
 */
import { describe, it, expect } from 'vitest'
import {
  processFoundation990Job,
  deriveNteeCodesForProfile,
  deriveStatesForProfile,
} from '../services/crawlers/foundation990Crawler.js'

function signals(over = {}) {
  return {
    location: { state: 'TN' },
    states: ['TN'],
    needs: new Set(),
    keywords: [],
    keywordSet: new Set(),
    occupation: new Set(),
    demographics: new Set(),
    military: new Set(),
    interests: new Set(),
    applicantTypes: new Set(),
    applicantType: 'individual',
    ...over,
  }
}

describe('foundation990 — deriveStatesForProfile', () => {
  it('returns ALL states (primary + secondary), not nationwide', () => {
    const s = signals({ location: { state: 'OH' }, states: ['OH', 'TN'] })
    expect(deriveStatesForProfile(s)).toEqual(['OH', 'TN'])
  })

  it('falls back to nationwide only when no state is known', () => {
    const s = signals({ location: {}, states: [] })
    expect(deriveStatesForProfile(s)).toEqual(['nationwide'])
  })
})

describe('foundation990 — deriveNteeCodesForProfile', () => {
  it('faith/church profile → X (religion)', () => {
    const s = signals({
      applicantType: 'church',
      keywords: ['church', 'ministry', 'congregation'],
    })
    expect(deriveNteeCodesForProfile(s)).toContain('X')
  })

  it('student profile → B (education)', () => {
    const s = signals({
      applicantType: 'student',
      needs: new Set(['education']),
      keywords: ['scholarship', 'college'],
    })
    expect(deriveNteeCodesForProfile(s)).toContain('B')
  })

  it('EMS/paramedic profile → M (public safety)', () => {
    const s = signals({
      occupation: new Set(['paramedic']),
      keywords: ['ems', 'ambulance', 'first responder'],
    })
    expect(deriveNteeCodesForProfile(s)).toContain('M')
  })

  it('never returns an empty set (falls back to T grantmakers)', () => {
    const s = signals({ applicantType: '', keywords: [], needs: new Set() })
    const codes = deriveNteeCodesForProfile(s)
    expect(codes.length).toBeGreaterThan(0)
    expect(codes).toContain('T')
  })
})

describe('foundation990 — processFoundation990Job (mocked ProPublica)', () => {
  // Build a mock ProPublica client that records the search params it received
  // and returns one foundation for the first (state, ntee, page=0) combo only.
  function makeMockClient() {
    const calls = []
    const search = async (params) => {
      calls.push(params)
      if (params.page === 0) {
        return {
          total_results: 1,
          organizations: [
            {
              ein: '123456789',
              name: 'TN Faith Community Foundation',
              state: params.state ?? 'TN',
              ntee_code: 'X20',
              grant_amount: 250_000,
              income_amount: 500_000,
              profile_url: 'https://projects.propublica.org/nonprofits/organizations/123456789',
            },
          ],
        }
      }
      return { total_results: 1, organizations: [] }
    }
    return { calls, search }
  }

  const fakeDb = { prepare: () => ({ all: async () => [], get: async () => null }) }

  it('searches DERIVED states/NTEE and inserts matched foundations', async () => {
    const mock = makeMockClient()
    const inserted = []

    const profileContext = {
      profile: { id: 'p-church-1', primary_type: 'church' },
      sections: {},
      signals: signals({
        location: { state: 'TN' },
        states: ['TN'],
        applicantType: 'church',
        keywords: ['church', 'ministry', 'faith'],
        keywordSet: new Set(['church', 'ministry', 'faith']),
        needs: new Set(['nonprofit_ministry']),
      }),
    }

    const result = await processFoundation990Job({
      db: fakeDb,
      job: { id: 'job-1', profile_id: 'p-church-1', parameters: { max_pages: 2 } },
      profileContext,
      deps: {
        searchOrganizations: mock.search,
        // accept every candidate so we exercise insertion deterministically
        computeMatchDecision: () => ({ decision: 'ACCEPT', score: 88, reasons: ['faith match'], explanation: 'ok' }),
        filterOutPipelineMembers: async (_db, _pid, opps) => ({ results: opps, excluded: 0, total: opps.length }),
        bulkUpsertFundingOpportunities: async (_db, opps) => {
          inserted.push(...opps)
          return { inserted: opps.map((_, i) => `id-${i}`) }
        },
      },
    })

    // It searched TN (derived from signals.states), NOT 'nationwide'.
    expect(mock.calls.length).toBeGreaterThan(0)
    expect(mock.calls.every((c) => c.state === 'TN')).toBe(true)
    // It searched a religion NTEE group (X) derived from the faith profile.
    expect(mock.calls.some((c) => c.ntee === 'X')).toBe(true)
    // It inserted a matched foundation (one per derived state×NTEE combo that
    // returned a result; the faith profile derives both X and grantmaker T).
    expect(result.result_count).toBeGreaterThanOrEqual(1)
    expect(result.result_meta.mode).toBe('profile_driven')
    expect(result.result_meta.derived_states).toEqual(['TN'])
    expect(result.result_meta.derived_ntee_codes).toContain('X')
    expect(inserted[0].match_score).toBe(88)
    expect(inserted.every((o) => o.match_decision === 'ACCEPT')).toBe(true)
  })

  it('drops REJECTED foundations and ones below the match floor', async () => {
    const mock = makeMockClient()
    const inserted = []
    const profileContext = {
      profile: { id: 'p-2' },
      sections: {},
      signals: signals(),
    }

    const result = await processFoundation990Job({
      db: fakeDb,
      job: { id: 'job-2', profile_id: 'p-2', parameters: { max_pages: 1 } },
      profileContext,
      deps: {
        searchOrganizations: mock.search,
        computeMatchDecision: () => ({ decision: 'REJECT', score: 0, reasons: ['mismatch'] }),
        filterOutPipelineMembers: async (_db, _pid, opps) => ({ results: opps, excluded: 0, total: opps.length }),
        bulkUpsertFundingOpportunities: async (_db, opps) => {
          inserted.push(...opps)
          return { inserted: opps.map((_, i) => `id-${i}`) }
        },
      },
    })

    expect(inserted.length).toBe(0)
    expect(result.result_count).toBe(0)
  })

  it('falls back to ADMIN-BATCH static defaults with no profileContext', async () => {
    const mock = makeMockClient()
    const inserted = []

    const result = await processFoundation990Job({
      db: fakeDb,
      job: { id: 'job-3', parameters: { max_pages: 1 } },
      deps: {
        searchOrganizations: mock.search,
        bulkUpsertFundingOpportunities: async (_db, opps) => {
          inserted.push(...opps)
          return { inserted: opps.map((_, i) => `id-${i}`) }
        },
      },
    })

    expect(result.result_meta.mode).toBe('admin_batch')
    // historical default: nationwide search (no state param) + NTEE 'T'
    expect(mock.calls.every((c) => c.state === undefined)).toBe(true)
    expect(mock.calls.every((c) => c.ntee === 'T')).toBe(true)
    // admin batch inserts qualified foundations directly (no matcher gate)
    expect(inserted.length).toBe(1)
  })
})
