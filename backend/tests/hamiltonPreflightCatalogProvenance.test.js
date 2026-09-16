import { describe, expect, it, vi } from 'vitest'

import { loadOpportunityForPreflight } from '../services/hamilton/hamiltonPreflight.js'

describe('Hamilton preflight shared-catalog lookup', () => {
  it('does not treat discovery profile_id provenance as catalog ownership', async () => {
    const get = vi.fn(async (...params) => ({
      id: params[0],
      profile_id: 'different-discovery-profile',
      title: 'Shared verified opportunity',
    }))
    const prepare = vi.fn(() => ({ get }))

    const row = await loadOpportunityForPreflight({ prepare }, 'opp-1')

    expect(row?.id).toBe('opp-1')
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare.mock.calls[0][0]).toBe('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
    expect(get).toHaveBeenCalledWith('opp-1')
  })
})
