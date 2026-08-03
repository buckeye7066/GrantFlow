import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  passesFundabilityGate,
  runCatalogRescoreSweep,
} from '../services/matching/catalogRescoreSweep.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalog rescore review follow-up', () => {
  it('evaluates the hot-path fundability gate synchronously', () => {
    const verdict = passesFundabilityGate({
      id: 'opp-1',
      title: 'Verified Scholarship',
      sponsor: 'Example Foundation',
      opportunity_kind: 'SCHOLARSHIP',
      application_url: 'https://example.org/apply',
      deadline_type: 'rolling',
    })

    expect(verdict).toBe(true)
    expect(verdict).not.toBeInstanceOf(Promise)
  })

  it('marks a pass truncated when the time budget expires inside the final profile', async () => {
    let expired = false
    vi.spyOn(Date, 'now').mockImplementation(() => (expired ? 2_000 : 0))

    const opportunity = {
      id: 'opp-time',
      title: 'Verified Scholarship',
      sponsor: 'Example Foundation',
      opportunity_kind: 'SCHOLARSHIP',
      application_url: 'https://example.org/apply',
      deadline_type: 'rolling',
      created_at: '2026-08-03T00:00:00.000Z',
      is_active: 1,
    }

    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        if (/SELECT id, created_by FROM profiles/i.test(sql)) {
          return { all: async () => [{ id: 'profile-1', created_by: null }] }
        }
        if (/SELECT COUNT\(\*\) AS c FROM funding_opportunities/i.test(sql)) {
          return { get: async () => ({ c: 1 }) }
        }
        if (/SELECT fo\.\* FROM funding_opportunities/i.test(sql)) {
          return { all: async () => [opportunity] }
        }
        throw new Error(`Unexpected SQL in test: ${sql}`)
      },
    }

    const result = await runCatalogRescoreSweep(db, {
      writeEnabled: false,
      pairBudget: 10,
      timeBudgetMs: 1_000,
      deps: {
        loadProfileContext: async () => ({
          profile: { id: 'profile-1', display_name: 'Real Profile', primary_type: 'student' },
          sections: {},
        }),
        assessProfileConfiguration: () => ({ unconfigured: false }),
        computeMatchDecision: () => {
          expired = true
          return { decision: 'review', score: 7 }
        },
      },
    })

    expect(result.adjudicated).toBe(1)
    expect(result.review).toBe(1)
    expect(result.truncated).toBe(true)
  })
})
