import { describe, expect, it } from 'vitest'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'

const profile = {
  primary_type: 'individual',
  state: 'TN',
  needs: ['healthcare', 'disability'],
  disability_status: true,
}

function storedOpportunity(overrides = {}) {
  return {
    id: 'stored-engine-row',
    title: 'Veterans and Military Family Assistance Grant',
    description: 'Assistance grants supporting veterans and military families with essential needs.',
    source: 'crawler-os',
    source_url: 'https://va.gov/family-assistance-grant',
    application_url: 'https://va.gov/family-assistance-grant/apply',
    state: 'TN',
    is_active: 1,
    categories: '["assistance"]',
    keywords: '["family assistance", "essential needs"]',
    match_score: 40,
    match_decision: 'ACCEPT',
    ...overrides,
  }
}

describe('stored canonical decisions are authoritative by default', () => {
  it('keeps an above-floor stored row when the caller omits useStoredDecision', () => {
    const { kept, dropped } = canonicalizeOpportunityList(profile, [storedOpportunity()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
    })
    expect(kept).toHaveLength(1)
    expect(dropped.veteran_military_without_profile_signal ?? 0).toBe(0)
    expect(kept[0].match_score).toBe(40)
  })

  it('every kept row carries bounded next-step guidance (nextStepGuidance resurrected, epic slice 3)', () => {
    const { kept } = canonicalizeOpportunityList(profile, [storedOpportunity()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
    })
    expect(kept).toHaveLength(1)
    const steps = kept[0].next_steps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.length).toBeLessThanOrEqual(4)
    for (const step of steps) {
      expect(typeof step.label).toBe('string')
      expect(step.label.length).toBeGreaterThan(0)
    }
  })

  it('uses the joined profile-scoped vNext state for sequential guidance', () => {
    const { kept } = canonicalizeOpportunityList(profile, [storedOpportunity({
      vnext_application_id: 'app-1',
      vnext_application_state: 'DEDUPED',
      vnext_application_stage: 'DEDUPED',
    })])

    const applicationSteps = kept[0].next_steps.filter((step) => step.category === 'application')
    expect(applicationSteps).toEqual([
      expect.objectContaining({
        id: 'qualify_application',
        meta: { target: 'QUALIFIED' },
      }),
    ])
  })

  it('the unknown-eligibility list is always an array, never undefined', () => {
    const { kept } = canonicalizeOpportunityList(profile, [storedOpportunity()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
    })
    expect(Array.isArray(kept[0].missing_eligibility_fields)).toBe(true)
  })

  it('an explicit false remains the strict unscored-lead opt-out', () => {
    const { kept, dropped } = canonicalizeOpportunityList(profile, [storedOpportunity()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: false,
    })
    expect(kept).toHaveLength(0)
    expect(dropped.veteran_military_without_profile_signal).toBe(1)
  })
})
