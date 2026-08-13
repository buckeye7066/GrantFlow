/**
 * A NEED'S SEARCH SUBJECT MUST NOT NAME A FOREIGN ENTITY (2026-08-13).
 *
 * MEASURED LIVE, not reasoned about. `buildSearchSubject` took
 * `example_search_terms[0]` off the shared need definition regardless of who was
 * asking. The need definitions in `profileIntelligence/needsTaxonomy.js` are
 * shared across entity types and their first example is written for whichever
 * entity the author had in mind, so a RESEARCH LAB's plan shipped:
 *
 *   staffing_salary    -> "SAFER grant fire department"
 *   training           -> "firefighter training grant"
 *   utilities_support  -> "LIHEAP utility assistance"   (a household program)
 *
 * Run against the live Brave backend for a biolab profile on 2026-08-13, the
 * staffing subject returned FEMA SAFER, IAFF firefighter guidance and the State
 * Firefighters' & Fire Marshals' Association. That is the north-star stage-1
 * failure in its worst form: the need does not resolve to NOTHING (which would
 * be visibly empty) — it resolves to the WRONG THING and returns real,
 * reachable, useless sources with full confidence.
 *
 * THIS TEST FAILS ON THE PRE-FIX CODE. Reverting `buildSearchSubject` to the
 * unconditional `example_search_terms[0]` reddens the research-lab case on all
 * three codes.
 *
 * The bar is deliberately NARROW: only vocabulary that names a DIFFERENT KIND OF
 * ORGANISATION is forbidden. A merely generic subject ("equipment grant
 * nonprofit") is allowed — a nonprofit lab may legitimately use it, and
 * inventing a narrower claim is the fabrication class this repo keeps relearning.
 */

import { describe, it, expect } from 'vitest'

import { deriveOrgNeeds, buildSearchSubject } from '../services/needs/orgNeedsTaxonomy.js'

/**
 * Vocabulary that names an entity a research lab IS NOT. Each entry is a
 * token-boundary phrase, so "fire" inside "fireproof" is not a hit.
 */
const FOREIGN_ENTITY_TERMS = Object.freeze([
  'fire department',
  'firefighter',
  'fire fighter',
  'safer grant',
  'liheap',
  'volunteer fire',
  'ems agency',
  'congregation',
])

function namesForeignEntity(subject) {
  const text = String(subject ?? '').toLowerCase()
  return FOREIGN_ENTITY_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))
}

const biolabProfile = { id: 'test-biolab', primary_type: 'research_lab' }

describe('a need search subject never names a foreign entity', () => {
  it('the research-lab plan carries no fire-service or household-program vocabulary', () => {
    const plan = deriveOrgNeeds({ profile: biolabProfile, sections: {} })
    expect(plan.open.length).toBeGreaterThan(0)

    const offenders = plan.open
      .map((need) => ({ code: need.code, subject: need.search_subject, hits: namesForeignEntity(need.search_subject) }))
      .filter((entry) => entry.hits.length > 0)

    expect(offenders).toEqual([])
  })

  it('the three measured offenders are specifically repaired', () => {
    const plan = deriveOrgNeeds({ profile: biolabProfile, sections: {} })
    const byCode = new Map(plan.open.map((n) => [n.code, n.search_subject]))

    // Each of these SHIPPED with a foreign-entity subject.
    for (const code of ['staffing_salary', 'training', 'utilities_support']) {
      const subject = byCode.get(code)
      expect(subject, `${code} must be present in the biolab plan`).toBeTruthy()
      expect(namesForeignEntity(subject), `${code} subject "${subject}"`).toEqual([])
      // and it must actually be about a laboratory, not merely scrubbed
      expect(subject.toLowerCase()).toMatch(/laborator|research/)
    }
  })

  it('an override is scoped to its blueprint and never leaks to another entity', () => {
    // A volunteer fire department legitimately WANTS the fire-service subject.
    const fireSubject = buildSearchSubject('training', 'volunteer_fire_department')
    expect(fireSubject.toLowerCase()).toContain('firefighter')

    // The lab override must not have replaced the shared default globally.
    const bareSubject = buildSearchSubject('training', null)
    expect(bareSubject.toLowerCase()).toContain('firefighter')

    const labSubject = buildSearchSubject('training', 'research_lab')
    expect(labSubject.toLowerCase()).toMatch(/laborator/)
  })
})
