/**
 * Multi-address profile signals.
 *
 * A person can have more than one address (student home vs. school, missionary
 * home vs. deployed, military home vs. duty station, a travel nurse's two homes).
 * buildProfileSignals must expose EVERY distinct state across the primary +
 * secondary address via a `states[]` array (primary first), while keeping the
 * single `location.state` as the primary for back-compat. buildSignalsFromContext
 * (the canonical signals adapter) must surface the same `states`/`locations`.
 */
import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { buildSignalsFromContext } from '../services/profileSignals/index.js'

describe('profileSignals — multi-address (primary + secondary)', () => {
  it('exposes both states when a secondary address is in a different state', () => {
    const signals = buildProfileSignals({
      profile: { id: 'p1', primary_type: 'college_student' },
      sections: {
        basic_information: {
          // Primary home: Ohio
          city: 'Columbus',
          state: 'OH',
          zip_code: '43004',
          // Secondary: school in Tennessee
          secondary_address: {
            line1: '1301 E Main St',
            city: 'Murfreesboro',
            state: 'TN',
            zip: '37132',
            type: 'School',
          },
        },
      },
    })

    // Primary stays the back-compat single state.
    expect(signals.location.state).toBe('OH')
    // states[] covers BOTH addresses, primary first.
    expect(Array.isArray(signals.states)).toBe(true)
    expect(signals.states).toEqual(['OH', 'TN'])
    // The secondary location is resolved with its own city/state/zip + type.
    expect(signals.secondaryLocation).toMatchObject({ state: 'TN', zip: '37132', type: 'School' })
    expect(signals.locations.map((l) => l.state)).toEqual(['OH', 'TN'])
  })

  it('derives the secondary state from ZIP alone (offline ZIP DB)', () => {
    const signals = buildProfileSignals({
      profile: { id: 'p2', primary_type: 'individual' },
      sections: {
        basic_information: {
          state: 'CA',
          zip_code: '90001',
          secondary_address: { zip: '37132', type: 'Duty station' },
        },
      },
    })
    expect(signals.states[0]).toBe('CA')
    expect(signals.states).toContain('TN') // 37132 → TN
  })

  it('is backward compatible: no secondary address ⇒ single state only', () => {
    const signals = buildProfileSignals({
      profile: { id: 'p3', primary_type: 'individual' },
      sections: { basic_information: { state: 'TN', zip_code: '37132' } },
    })
    expect(signals.location.state).toBe('TN')
    expect(signals.states).toEqual(['TN'])
    expect(signals.secondaryLocation).toBeNull()
  })

  it('dedupes when both addresses share a state', () => {
    const signals = buildProfileSignals({
      profile: { id: 'p4', primary_type: 'individual' },
      sections: {
        basic_information: {
          state: 'TN',
          zip_code: '37132',
          secondary_address: { city: 'Nashville', state: 'TN', zip: '37201', type: 'Work' },
        },
      },
    })
    expect(signals.states).toEqual(['TN'])
  })

  it('buildSignalsFromContext surfaces states[] + locations[] on the analysis shape', () => {
    const profileContext = {
      profile_id: 'p5',
      profile: { id: 'p5', display_name: 'Out-of-state Student', primary_type: 'college_student' },
      sections: {
        basic_information: {
          state: 'OH',
          zip_code: '43004',
          secondary_address: { state: 'TN', zip: '37132', type: 'Campus' },
        },
      },
      signals: buildProfileSignals({
        profile: { id: 'p5', primary_type: 'college_student' },
        sections: {
          basic_information: {
            state: 'OH',
            zip_code: '43004',
            secondary_address: { state: 'TN', zip: '37132', type: 'Campus' },
          },
        },
      }),
    }

    const { signals } = buildSignalsFromContext(profileContext)
    expect(signals.states).toEqual(['OH', 'TN'])
    expect(signals.location.state).toBe('OH') // back-compat primary
    expect(signals.locations.map((l) => l.state)).toEqual(['OH', 'TN'])
    expect(signals.secondaryLocation).toMatchObject({ state: 'TN', type: 'Campus' })
  })
})
