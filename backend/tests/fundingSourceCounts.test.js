import { describe, expect, it } from 'vitest'
import { fundingSourceCounts } from '../../src/components/funding/fundingSourceCounts.js'

describe('profile funding-source result counts', () => {
  it('keeps a resource-only response visible without calling it direct funding', () => {
    expect(fundingSourceCounts({
      total: 0,
      resource_count: 3,
      directories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })).toEqual({ direct: 0, resources: 3, any: true })
  })

  it('falls back to the directory array during a rolling frontend/backend deployment', () => {
    expect(fundingSourceCounts({ total: 0, directories: [{ id: 'a' }] }))
      .toEqual({ direct: 0, resources: 1, any: true })
  })

  it('reports a true empty state only when neither direct funding nor resources exist', () => {
    expect(fundingSourceCounts({ total: 0, resource_count: 0, directories: [] }))
      .toEqual({ direct: 0, resources: 0, any: false })
  })
})
