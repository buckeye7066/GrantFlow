import { describe, it, expect } from 'vitest'
import { computeClientPipelineDollar, WIDE_AWARD_RANGE_RATIO } from './pipelineDollarClient'

describe('computeClientPipelineDollar (client fallback)', () => {
  it('preserves awarded amount for awarded rows', () => {
    const g = { status: 'awarded', amount_awarded: 12345, pipeline_dollar_value: 0 }
    expect(computeClientPipelineDollar(g)).toBe(12345)
  })

  it('applies >10x floor when requested equals ceiling', () => {
    const g = { status: 'submitted', amount_requested: 42000000, amount_min: 1000000, amount_max: 42000000 }
    expect(computeClientPipelineDollar(g)).toBe(1_000_000)
  })

  it('applies >10x floor when no requested is present', () => {
    const g = { status: 'submitted', amount_min: 1000000, amount_max: 42000000 }
    expect(computeClientPipelineDollar(g)).toBe(1_000_000)
  })

  it('keeps ordinary ceiling when range is not wide', () => {
    const g = { status: 'submitted', amount_min: 1000, amount_max: 5000 }
    expect(computeClientPipelineDollar(g)).toBe(5000)
  })
})

