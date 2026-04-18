/**
 * makeDecision.geography.test.js
 *
 * Verifies the "geography must expand outward" rule:
 *   - Cross-state opps are NO LONGER hard-rejected by default.
 *   - They are downgraded to REVIEW so the UI still surfaces them.
 *   - HARD REJECT is preserved only when the opp explicitly declares state
 *     exclusivity (e.g. "Ohio residents only").
 */
import { describe, it, expect } from 'vitest'
import { makeDecision } from '../services/matchEngine.js'
import { ACCEPT_SCORE } from '../config/matchThresholds.js'

const TN_PROFILE = { state: 'TN', primary_type: 'individual' }

describe('makeDecision: geographic state handling (expand-outward rule)', () => {
  it('cross-state opp without exclusive language → REVIEW, not REJECT', () => {
    const opp = {
      title: 'Ohio Community Health Program',
      description: 'Supports Ohio-area community health workers.',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('REVIEW')
    expect(result.explanation).toMatch(/may be accessible/i)
  })

  it('cross-state opp with "residents only" language → REJECT', () => {
    const opp = {
      title: 'Ohio Emergency Aid',
      description: 'Ohio residents only.',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('REJECT')
  })

  it('national opp matches any state → not rejected for geography', () => {
    const opp = {
      title: 'National Housing Assistance',
      description: 'Available nationwide.',
      state: 'nationwide',
      is_national: true,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('ACCEPT')
  })

  it('same-state opp is not flagged by geography rule', () => {
    const opp = {
      title: 'Tennessee Community Grant',
      description: 'For TN residents.',
      state: 'TN',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('ACCEPT')
  })

  it('profile with no state: cross-state opp passes geography check', () => {
    const profNoState = { primary_type: 'individual' }
    const opp = {
      title: 'Ohio Emergency Aid',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, profNoState, opp)
    expect(result.decision).toBe('ACCEPT')
  })
})
