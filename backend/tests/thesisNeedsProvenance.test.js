/**
 * A DEFAULTED need set is labelled as one.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `deriveNeeds` falls back to a need set derived purely from the profile's TYPE
 * when the profile declares nothing readable. Measured 2026-08-21: a blank
 * nonprofit thesis carried ['capacity_building','capital','programs','operations']
 * and a described food-bank nonprofit carried ['food','emergency'] — and the
 * thesis presented both with IDENTICAL confidence, because the fallback left no
 * trace. `buildProfileSignals` had computed exactly this distinction all along
 * (`needsDefaulted`) and it was dropped before the thesis, so no consumer could
 * act on it. CLAUDE.md states the doctrine plainly: "we could not read it" is
 * not "there is nothing".
 *
 * NOT what this fixes: a 2026-08-21 audit reported these org profiles deriving
 * an EMPTY need set that then "fails open" in planner.servesNeed. That did not
 * reproduce — it measured `buildProfileSignals().needs` (an object, `{}`) and
 * attributed it to `thesis.needs` (an array, populated). The guard in
 * servesNeed is a LENGTH test, which is why the object/array distinction below
 * is pinned: returning a non-array here really would open the need gate for
 * every profile in the fleet.
 */
import { describe, it, expect } from 'vitest'
import { buildThesis } from '../crawler-os/profileIntelligence.js'
import { profileContextToThesisInput } from '../services/crawlerOsPersistenceCore.js'

function thesisFor(profile) {
  return buildThesis(profileContextToThesisInput({ profile, sections: profile.sections }))
}

const BLANK_ORG = { id: 'b', primary_type: 'nonprofit', full_name: 'Blank Org', sections: {} }

const DESCRIBED_ORG = {
  id: 'd',
  primary_type: 'nonprofit',
  full_name: 'Described Org',
  sections: {
    programs_services: { focus_areas: ['food_security'], interests: ['food bank', 'hunger relief'] },
    narrative: { primary_goal: 'Operate a food pantry for the county.' },
  },
}

describe('thesis.needs_defaulted', () => {
  it('is TRUE when the need set was invented from the profile type', () => {
    const t = thesisFor(BLANK_ORG)
    expect(t.needs_defaulted).toBe(true)
    // The fallback itself is deliberately KEPT — removing it would zero-result
    // every sparse profile. It just has to be honest about what it is.
    expect(t.needs.length).toBeGreaterThan(0)
  })

  it('is FALSE when the profile actually declared something', () => {
    const t = thesisFor(DESCRIBED_ORG)
    expect(t.needs_defaulted).toBe(false)
    expect(t.needs).toContain('food')
  })

  it('distinguishes the two — which is the whole point', () => {
    expect(thesisFor(BLANK_ORG).needs_defaulted)
      .not.toBe(thesisFor(DESCRIBED_ORG).needs_defaulted)
  })

  it('is an explicit boolean, never undefined', () => {
    // A consumer must be able to tell "not defaulted" from "this thesis predates
    // the field"; `undefined` collapses those into one falsy value.
    for (const p of [BLANK_ORG, DESCRIBED_ORG]) {
      expect(typeof thesisFor(p).needs_defaulted).toBe('boolean')
    }
  })

  it('THE TRAP: needs stays a real ARRAY, so the need gate does not fail open', () => {
    // planner.servesNeed guards with `if (!thesis.needs?.length) return true`.
    // `({}).length` is undefined, so a non-array here would make that guard
    // return true for EVERY profile and silently disable need-based lane
    // exclusion fleet-wide.
    for (const p of [BLANK_ORG, DESCRIBED_ORG]) {
      const needs = thesisFor(p).needs
      expect(Array.isArray(needs)).toBe(true)
      expect(needs.length).toBeGreaterThan(0)
      expect(Boolean(needs.length)).toBe(true)
    }
  })

  it('survives JSON round-trip as an array (the thesis is persisted)', () => {
    const t = thesisFor(BLANK_ORG)
    const round = JSON.parse(JSON.stringify(t))
    expect(Array.isArray(round.needs)).toBe(true)
    expect(round.needs).toEqual([...t.needs])
    expect(round.needs_defaulted).toBe(true)
  })
})
