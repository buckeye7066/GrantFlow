import { describe, it, expect } from 'vitest'
import {
  CLIENT_NO_PER_AWARD_KINDS,
  computeClientPipelineDollar,
  WIDE_AWARD_RANGE_RATIO,
} from './pipelineDollarClient'

describe('computeClientPipelineDollar (client fallback)', () => {
  it('preserves awarded amount for awarded rows', () => {
    const g = { status: 'awarded', amount_awarded: 12345, pipeline_dollar_value: 0 }
    expect(computeClientPipelineDollar(g)).toBe(12345)
  })

  it('treats the server-calculated zero as authoritative', () => {
    const g = { status: 'submitted', pipeline_dollar_value: 0, amount_requested: 999999 }
    expect(computeClientPipelineDollar(g)).toBe(0)
  })

  it('zeroizes rejected and explicitly ineligible stale-client rows', () => {
    expect(computeClientPipelineDollar({ amount_requested: 5000, match_decision: 'REJECT' })).toBe(0)
    expect(computeClientPipelineDollar({ amount_requested: 5000, eligibility_status: 'INELIGIBLE' })).toBe(0)
  })

  it('zeroizes every no-per-award kind when the server field is unavailable', () => {
    for (const kind of CLIENT_NO_PER_AWARD_KINDS) {
      expect(computeClientPipelineDollar({ amount_requested: 5000, opportunity_kind: kind })).toBe(0)
    }
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
  it('ignores non-positive client fallback amounts', () => {
    expect(computeClientPipelineDollar({ amount_requested: -10, amount_max: 5000 })).toBe(5000)
    expect(computeClientPipelineDollar({ amount_min: -1, amount_max: 5 })).toBe(5)
    expect(WIDE_AWARD_RANGE_RATIO).toBe(10)
  })
})
