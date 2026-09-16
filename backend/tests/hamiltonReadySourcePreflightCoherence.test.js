import { describe, expect, it } from 'vitest'

import {
  HAMILTON_READY_SOURCE_POLICY_PROOF,
  preflightSingleSource,
} from '../services/hamilton/hamiltonPreflight.js'

describe('Hamilton ready-source/preflight coherence', () => {
  it('honors only the unforgeable same-request policy proof without serializing it', async () => {
    const source = { grant_id: 'grant-1', opportunity_id: 'opp-1' }
    Object.defineProperty(source, HAMILTON_READY_SOURCE_POLICY_PROOF, {
      value: { ok: true, warnings: [] },
      enumerable: false,
    })

    const result = await preflightSingleSource(null, {
      profileId: 'profile-1',
      profile: {
        first_name: 'Test',
        last_name: 'Applicant',
        email: 'test@example.invalid',
      },
      source,
      opportunity: { id: 'opp-1', title: 'Verified opportunity' },
      grant: { id: 'grant-1', funding_opportunity_id: 'opp-1' },
    })

    expect(result.blockers.some((blocker) => blocker.kind === 'funding_source_policy')).toBe(false)
    expect(JSON.stringify(source)).not.toContain('hamilton-ready-source-policy-proof')
    expect(Object.getOwnPropertySymbols(source)).toContain(HAMILTON_READY_SOURCE_POLICY_PROOF)
  })
})
