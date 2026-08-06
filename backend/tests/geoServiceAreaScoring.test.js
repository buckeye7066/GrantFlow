/**
 * geoServiceAreaScoring.test.js
 *
 * Bug: geo-matching ignored the profile's SERVICE AREA and scored geographic
 * fit off the MAILING / home address instead. Demo Faith-Based Nonprofit is
 * headquartered (mailing address) in Cleveland, TN but DELIVERS services on the
 * Pine Ridge Reservation, South Dakota. Its matched sources were dominated by
 * Tennessee programs because the matcher resolved the profile's state from the
 * mailing address rather than the "Location Focus / geographic focus / service
 * area" field.
 *
 * Canonical rule G4 (geographic matching): matching must reflect where the
 * profile is served. The fix weights the service-area / geographic-focus field
 * OVER the mailing/home address when resolving the profile's primary state:
 *   - extractStateFromContext() resolves location_focus.{service_area,
 *     geographic_focus,primary_state,state} FIRST.
 *   - buildProfileSignals().states[] folds in the service-area state (so it is
 *     primary) while still appending the home-address state (so home-state
 *     sources remain eligible, just lower priority).
 *
 * Invariant compliance: this only changes WHICH location drives the score, not
 * the relevance/match-score floor. National + state-tier scores are unchanged in
 * magnitude; missing fields stay neutral (a profile with no service area is
 * identical to before — covered below).
 */
import { describe, it, expect } from 'vitest'
import { buildProfileSignals, extractStateFromContext } from '../services/profileHelpers.js'
import { computeMatchDecision } from '../services/matchEngine.js'

// Demo Faith-Based Nonprofit: mailing address Cleveland, TN; service area Pine
// Ridge Reservation, South Dakota.
const FOCUS_FORWARD_PROFILE = { id: 'p-focus-forward', primary_type: 'nonprofit', state: 'TN' }
const FOCUS_FORWARD_SECTIONS = {
  basic_information: {
    state: 'TN',
    city: 'Cleveland',
    address: '123 Mission Way, Cleveland, TN 37311',
  },
  location_focus: {
    geographic_focus: 'Pine Ridge Reservation, South Dakota',
  },
}

const SD_OPP = {
  id: 'sd-opp',
  title: 'South Dakota Tribal Community Assistance',
  description: 'Local assistance for residents and organizations serving South Dakota communities.',
  application_url: 'https://sd.example.org/assistance',
  state: 'SD',
  is_national: false,
  categories: ['community'],
}
const TN_OPP = {
  id: 'tn-opp',
  title: 'Bradley County Tennessee Family Assistance',
  description: 'Local assistance for Tennessee residents in Bradley County.',
  application_url: 'https://tn.example.org/assistance',
  state: 'TN',
  is_national: false,
  categories: ['community'],
}

const geoComponentOf = (decision) =>
  decision.match_explain?.scoreBreakdown?.geo ??
  decision.match_explain?.scoreBreakdown?.geo_component ??
  0

describe('geo scoring prefers the service area over the mailing address', () => {
  it('extractStateFromContext resolves the SERVICE-AREA state (SD), not the mailing state (TN)', () => {
    const state = extractStateFromContext({
      profile: FOCUS_FORWARD_PROFILE,
      sections: FOCUS_FORWARD_SECTIONS,
    })
    expect(state).toBe('SD')
  })

  it('buildProfileSignals puts the service-area state (SD) primary and still covers the home state (TN)', () => {
    const sig = buildProfileSignals({
      profile: FOCUS_FORWARD_PROFILE,
      sections: FOCUS_FORWARD_SECTIONS,
    })
    expect(sig.location.state).toBe('SD')
    expect(sig.states[0]).toBe('SD') // service area is primary
    expect(sig.states).toContain('TN') // home state still eligible
  })

  it('an SD opportunity gets full in-state geo credit (>=75), not a cross-state mismatch', () => {
    const decision = computeMatchDecision(FOCUS_FORWARD_PROFILE, SD_OPP, {
      profileSections: FOCUS_FORWARD_SECTIONS,
    })
    expect(decision.decision).not.toBe('REJECT')
    expect(geoComponentOf(decision)).toBeGreaterThanOrEqual(75)
  })

  it('the SD service-area opportunity scores its geo at least as high as the TN home-address one', () => {
    const sd = computeMatchDecision(FOCUS_FORWARD_PROFILE, SD_OPP, {
      profileSections: FOCUS_FORWARD_SECTIONS,
    })
    const tn = computeMatchDecision(FOCUS_FORWARD_PROFILE, TN_OPP, {
      profileSections: FOCUS_FORWARD_SECTIONS,
    })
    // Before the fix, only TN scored in-state (75) and SD was a mismatch (10).
    // The service area must now drive the score: SD is no longer crowded out.
    expect(geoComponentOf(sd)).toBeGreaterThanOrEqual(geoComponentOf(tn))
    expect(geoComponentOf(sd)).toBeGreaterThanOrEqual(75)
  })
})

describe('regression: profiles WITHOUT a service area are unchanged (missing = neutral)', () => {
  // A plain individual whose home IS their service area: no location_focus.
  const HOME_ONLY_PROFILE = { id: 'p-home', primary_type: 'individual', state: 'TN' }
  const HOME_ONLY_SECTIONS = { basic_information: { state: 'TN', city: 'Cleveland' } }

  it('extractStateFromContext returns the mailing state when no service area is set', () => {
    expect(extractStateFromContext({ profile: HOME_ONLY_PROFILE, sections: HOME_ONLY_SECTIONS })).toBe('TN')
  })

  it('buildProfileSignals surfaces exactly the home state when no service area is set', () => {
    const sig = buildProfileSignals({ profile: HOME_ONLY_PROFILE, sections: HOME_ONLY_SECTIONS })
    expect(sig.location.state).toBe('TN')
    expect(sig.states).toEqual(['TN'])
  })

  it('a TN opportunity still scores in-state for a TN-home-only profile', () => {
    const decision = computeMatchDecision(HOME_ONLY_PROFILE, TN_OPP, { profileSections: HOME_ONLY_SECTIONS })
    expect(geoComponentOf(decision)).toBeGreaterThanOrEqual(75)
  })
})
