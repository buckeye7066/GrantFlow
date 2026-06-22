import { describe, it, expect } from 'vitest'
import { reviewOpportunity } from '../services/reviewerAgent.js'

// Baseline "real-looking" opp used as a starting point for each test
function baseOpp(over = {}) {
  return {
    title: 'Community Emergency Assistance Grant',
    sponsor: 'Example Foundation',
    description:
      'Supports local community organizations providing emergency assistance to households in need.',
    source: 'test',
    source_id: 'base-1',
    source_url: 'https://example.org/program',
    application_url: 'https://example.org/apply',
    amount_min: 1000,
    amount_max: 25000,
    is_national: true,
    opportunity_type: 'grant',
    ...over,
  }
}

describe('reviewerAgent.reviewOpportunity', () => {
  it('accepts a realistic opportunity', () => {
    const res = reviewOpportunity(baseOpp())
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.warnings)).toBe(true)
  })

  it('rejects missing opportunity object', () => {
    const res = reviewOpportunity(null)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('reviewer:missing_opportunity')
  })

  it('rejects placeholder titles (only exact-token placeholders or filler phrasing)', () => {
    // Must be rejected: exact-token placeholders and obvious filler phrasing.
    // "Test Grant" / "Sample Opportunity" / "Example Program" are intentionally
    // NOT in this list — the canonical placeholder filter in
    // backend/services/shared/opportunityPolicy.js (runs before the reviewer)
    // decides on substring-based rejections, and the inserter-level contract
    // in tests/unit/opportunityInserter.test.mjs requires titles like
    // "Example Opportunity" to continue to flow through.
    for (const title of [
      'Placeholder',
      'Lorem ipsum dolor',
      'Untitled',
      'TBD',
      'todo',
      '[needs title]',
      '...',
    ]) {
      const res = reviewOpportunity(baseOpp({ title }))
      expect(res.ok, `title="${title}" should be rejected`).toBe(false)
      expect(res.reason).toBe('reviewer:placeholder_title')
    }
  })

  it('does NOT reject titles that merely start with "example/test/sample"', () => {
    // Regression guard: a loose prefix rule here breaks the contract that
    // opportunityInserter accepts generic-sounding program titles. Substring
    // rejection belongs to opportunityPolicy, not the reviewer.
    for (const title of ['Example Opportunity', 'Test Grant', 'Sample Opportunity', 'Example Program']) {
      const res = reviewOpportunity(baseOpp({ title }))
      expect(res.ok, `title="${title}" must pass the reviewer`).toBe(true)
    }
  })

  it('rejects extremely short or long titles', () => {
    expect(reviewOpportunity(baseOpp({ title: 'AB' })).reason).toBe('reviewer:title_too_short')
    expect(reviewOpportunity(baseOpp({ title: 'x'.repeat(600) })).reason).toBe(
      'reviewer:title_too_long',
    )
  })

  it('rejects LLM hallucination markers', () => {
    const res = reviewOpportunity(
      baseOpp({
        description:
          "I'm sorry, but I cannot provide real funding information. As an AI, I can only suggest fictional opportunities.",
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('reviewer:hallucination_marker')
  })

  it('rejects placeholder sponsors', () => {
    const res = reviewOpportunity(baseOpp({ sponsor: 'Unknown' }))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('reviewer:placeholder_sponsor')
  })

  it('rejects title===sponsor only when description is empty (hallucination shape)', () => {
    const sameName = 'National Health Initiative'
    const hard = reviewOpportunity(
      baseOpp({ title: sameName, sponsor: sameName, description: '' }),
    )
    expect(hard.ok).toBe(false)
    expect(hard.reason).toBe('reviewer:title_equals_sponsor')

    const soft = reviewOpportunity(
      baseOpp({ title: sameName, sponsor: sameName }), // keeps base description
    )
    expect(soft.ok).toBe(true)
    expect(soft.warnings).toContain('title_equals_sponsor')
  })

  it('rejects implausible amounts', () => {
    expect(reviewOpportunity(baseOpp({ amount_min: -1 })).reason).toBe(
      'reviewer:negative_amount_min',
    )
    expect(reviewOpportunity(baseOpp({ amount_max: -1 })).reason).toBe(
      'reviewer:negative_amount_max',
    )
    expect(reviewOpportunity(baseOpp({ amount_max: 1e12 })).reason).toBe(
      'reviewer:implausible_amount_max',
    )
  })

  it('warns — does not reject — when amount_min > amount_max', () => {
    const res = reviewOpportunity(baseOpp({ amount_min: 5000, amount_max: 1000 }))
    expect(res.ok).toBe(true)
    expect(res.warnings).toContain('amount_min_gt_max')
  })

  it('rejects firm deadlines definitively in the past', () => {
    const res = reviewOpportunity(
      baseOpp({ deadline: '1999-01-01', deadline_type: 'fixed' }),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('reviewer:firm_deadline_in_past')
  })

  it('ACCEPTS past-looking deadlines when type is rolling/unknown (recall over suppression)', () => {
    const rolling = reviewOpportunity(
      baseOpp({ deadline: '1999-01-01', deadline_type: 'rolling' }),
    )
    expect(rolling.ok).toBe(true)

    const unknown = reviewOpportunity(baseOpp({ deadline: '1999-01-01' }))
    expect(unknown.ok).toBe(true)
  })

  it('ACCEPTS past firm deadlines for DIRECTORY-style records', () => {
    const res = reviewOpportunity(
      baseOpp({
        type: 'DIRECTORY',
        deadline: '1999-01-01',
        deadline_type: 'fixed',
      }),
    )
    expect(res.ok).toBe(true)
  })

  it('rejects degenerate single-character descriptions', () => {
    const res = reviewOpportunity(baseOpp({ description: 'aaaaaaaaaaaaaaaaaaaaaaaa' }))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('reviewer:description_degenerate')
  })
})
