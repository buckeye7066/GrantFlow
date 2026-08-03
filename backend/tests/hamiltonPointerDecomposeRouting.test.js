/**
 * Layer 3 of listing-decomposition-apply: a POINTER row (directory / referral /
 * school_portal / past_award_intel) that carries a usable web URL must route to
 * the portal engine so listing triage can decompose it — NOT to a static
 * no_application packet that turns the whole page of awards down.
 */
import { describe, it, expect } from 'vitest'
import { classifyFundingSource } from '../services/hamilton/hamiltonAutomationClassifier.js'

describe('pointer-kind decomposition routing (classifier)', () => {
  it('routes a directory row WITH a url to portal (decompose), not no_application', () => {
    const r = classifyFundingSource({
      opportunity: {
        opportunity_kind: 'directory',
        url: 'https://www.scholarships.com/financial-aid/college-scholarships/scholarships-by-major/nursing-scholarships',
      },
    })
    expect(r.automation_type).toBe('portal')
    expect(r.reasons.some((x) => x.rule === 'pointer_kind.decompose')).toBe(true)
  })

  it('routes referral / school_portal / past_award_intel with a url to portal', () => {
    for (const kind of ['referral', 'school_portal', 'past_award_intel']) {
      const r = classifyFundingSource({
        opportunity: { opportunity_kind: kind, url: 'https://example.org/list' },
      })
      expect(r.automation_type, `${kind} should decompose`).toBe('portal')
    }
  })

  it('keeps no_application for a directory with NO usable url', () => {
    const r = classifyFundingSource({ opportunity: { opportunity_kind: 'directory', url: null } })
    expect(r.automation_type).toBe('no_application')
  })

  it('does NOT reroute non-pointer kinds (a scholarship keeps its normal routing)', () => {
    const r = classifyFundingSource({
      opportunity: { opportunity_kind: 'scholarship', url: 'https://example.org/apply' },
    })
    expect(r.automation_type).toBe('portal')
    expect(r.reasons.some((x) => x.rule === 'pointer_kind.decompose')).toBe(false)
  })

  it('leaves FAFSA/auto-profile precedence intact (pointer check is below it)', () => {
    // A directory-kind row whose text is pure FAFSA linkage still classifies
    // auto_profile — the pointer check sits AFTER the auto-profile signals.
    const r = classifyFundingSource({
      opportunity: {
        opportunity_kind: 'directory',
        url: 'https://studentaid.gov',
        description: 'Complete the FAFSA to be considered; awards are made automatically from your FAFSA.',
      },
    })
    expect(r.automation_type).toBe('auto_profile')
  })
})
