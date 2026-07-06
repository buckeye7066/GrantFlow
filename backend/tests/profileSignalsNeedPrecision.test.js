import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'

// Regression: the signal-derived needs list feeds the NEED-ANCHORED score's
// coverage denominator (collectProfileNeeds → needCoverage%) and steers
// discovery queries. Substring keyword matching fabricated needs out of word
// fragments — 'bus' ⊂ "business" (phantom transportation), 'rent' ⊂
// "current"/"parent" (phantom housing) — diluting every real need's share of
// the score. Needs may only come from whole-word evidence.
describe('buildProfileSignals need precision (whole-word scanning)', () => {
  it('a business narrative does not fabricate transportation/housing needs', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN', city: 'Cleveland' },
        financial_information: {
          funding_needs: 'We want to grow our business and hire staff for our current programs.',
        },
      },
    })
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('business')
    expect(needs).not.toContain('transportation') // 'bus' ⊂ "business"
    expect(needs).not.toContain('housing') // 'rent' ⊂ "current"
  })

  it('real whole-word need evidence still derives the need', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN' },
        financial_information: {
          funding_needs: 'Behind on rent; need bus passes and help with the electric utility bill.',
        },
      },
    })
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('housing')
    expect(needs).toContain('transportation')
    expect(needs).toContain('utilities')
  })

  it('a needs-silent ORGANIZATION falls back to org-generic needs, not the person-benefit set', () => {
    // The Focus Forward class: every needs-silent profile used to get
    // utilities/housing/food/healthcare/cash_assistance injected — a church
    // "needing" rent help. On the need-anchored scale those phantom needs ARE
    // the coverage denominator, so person-benefit programs scored as fits.
    const sig = buildProfileSignals({
      profile: { primary_type: 'church' },
      sections: { basic_information: { state: 'OH', city: 'Vermilion' } },
    })
    const needs = [...(sig.needs ?? [])]
    for (const junk of ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance']) {
      expect(needs).not.toContain(junk)
    }
    for (const orgNeed of ['operations', 'programs', 'capacity_building']) {
      expect(needs).toContain(orgNeed)
    }
  })

  it('a needs-silent untyped/person profile keeps the person-benefit fallback (safe default)', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: { basic_information: { state: 'TN' } },
    })
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('housing')
    expect(needs).toContain('food')
  })
})
