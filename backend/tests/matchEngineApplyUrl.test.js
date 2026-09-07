/**
 * The apply target lives in `apply_url` (schema truth) as often as in
 * `application_url`. The engine must read both, or an otherwise-ACCEPT pair
 * is downgraded to REVIEW "missing application URL" while the row carries a
 * live apply link (prod 2026-09-07: 176 rows / 18 profiles).
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'

const PROFILE = { primary_type: 'individual', state: 'OH', needs: ['housing', 'utilities'] }
const BASE = {
  title: 'Ohio Housing and Utility Assistance',
  description: 'For Ohio residents facing eviction or utility shutoff.',
  is_national: 0,
  state: 'OH',
  entity_types_allowed: '["individual"]',
  categories: '["housing", "utilities"]',
  keywords: '["rent", "utilities", "eviction"]',
  is_loan: 0,
}

describe('engine apply target', () => {
  it('no URL at all → not ACCEPT', () => {
    const r = computeMatchDecision(PROFILE, { ...BASE })
    expect(r.decision).not.toBe('ACCEPT')
  })

  it('apply_url alone is an apply target: same decision as application_url', () => {
    const viaApplication = computeMatchDecision(PROFILE, { ...BASE, application_url: 'https://example.org/apply' })
    const viaApply = computeMatchDecision(PROFILE, { ...BASE, apply_url: 'https://example.org/apply' })
    expect(viaApply.decision).toBe(viaApplication.decision)
    expect(viaApply.explanation).not.toMatch(/missing application URL/i)
  })

  it('a bare source_url is a listing page, not an apply target', () => {
    const r = computeMatchDecision(PROFILE, { ...BASE, source_url: 'https://example.org/listing' })
    expect(r.decision).not.toBe('ACCEPT')
  })
})
