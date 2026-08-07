import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL = process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY
  else process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = ORIGINAL
  vi.resetModules()
})

describe('SOFT_RELEVANCE_PENALTY environment override', () => {
  it('falls back to the model default when the override is empty', async () => {
    process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = '   '
    vi.resetModules()
    const thresholds = await import('../config/matchThresholds.js')
    expect(thresholds.SOFT_RELEVANCE_PENALTY)
      .toBe(thresholds.SCORING_MODEL === 'data_point' ? 4 : 25)
  })

  it('still accepts an explicit zero override', async () => {
    process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = '0'
    vi.resetModules()
    const thresholds = await import('../config/matchThresholds.js')
    expect(thresholds.SOFT_RELEVANCE_PENALTY).toBe(0)
  })
})
