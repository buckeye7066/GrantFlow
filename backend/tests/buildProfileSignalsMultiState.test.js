import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'

// Regression: the CRAWL path (buildProfileSignals.states) must surface a second
// address no matter which field it was entered in, so local crawlers cover every
// state the profile touches. Single-address profiles must be unchanged.
describe('buildProfileSignals multi-state coverage (crawl path)', () => {
  it('single address yields exactly its state', () => {
    const sig = buildProfileSignals({
      profile: {}, sections: { basic_information: { state: 'OH', city: 'Vermilion' } },
    })
    expect(sig.states).toEqual(['OH'])
  })

  it('basic_information.secondary_address adds the second state', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'OH', secondary_address: { state: 'TN', city: 'Cleveland' } },
      },
    })
    expect(sig.states).toContain('OH')
    expect(sig.states).toContain('TN')
  })

  it('secondary address in location_focus is also covered', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'OH' },
        location_focus: { secondary_address: { state: 'TN' } },
      },
    })
    expect(sig.states).toContain('TN')
  })

  it('an explicit states[] / service_states array is folded in', () => {
    const sig = buildProfileSignals({
      profile: { states: ['KY'] },
      sections: {
        basic_information: { state: 'OH' },
        organization_details: { service_states: ['TN', 'GA'] },
      },
    })
    for (const st of ['OH', 'KY', 'TN', 'GA']) expect(sig.states).toContain(st)
  })
})
