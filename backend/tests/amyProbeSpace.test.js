/**
 * amyProbeSpace.test.js — TOTALITY over the adversarial probe space.
 *
 * Every axis value comes from a canonical registry. The whole point of that is
 * that a registry ADDITION cannot silently fall out of Amy's search — so these
 * tests assert the derivation is total in BOTH directions, and that the
 * denominator the convergence metric divides by is real.
 */

import { describe, it, expect } from 'vitest'
import {
  ROOT_CLASS,
  ENTITY_IDS,
  IDENTITY_IDS,
  NEED_IDS,
  NEED_APPLICABILITY,
  NEED_GROUP_ROLE,
  OBSERVED_NEED_GROUPS,
  STATE_IDS,
  LOCALITIES,
  entityRoot,
  entityClass,
  observedEntityRoots,
  identityParts,
  localityFor,
  cellKey,
  parseCellKey,
  cellPairs,
  isPlausibleCell,
  enumerateReachablePairs,
  reachablePairCount,
} from '../services/amy/probeSpace.js'
import { PROFILE_TYPES } from '../services/profileTypeRegistry.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js'
import { HEALTH_DIAGNOSIS_FLAGS } from '../services/profileHelpers.js'

describe('entity axis — every profile type classifies, derived from the registry', () => {
  it('declares a class for every ROOT the live registry produces', () => {
    const roots = observedEntityRoots()
    expect(roots.length).toBeGreaterThan(0)
    const undeclared = roots.filter((r) => !ROOT_CLASS[r])
    expect(undeclared).toEqual([])
  })

  it('classifies EVERY profile type (none falls out of the axis)', () => {
    const unclassified = ENTITY_IDS.filter((e) => !entityClass(e))
    expect(unclassified).toEqual([])
    expect(ENTITY_IDS.length).toBe(Object.keys(PROFILE_TYPES).length)
  })

  it('resolves a root TRANSITIVELY, not by taking the last parent', () => {
    // The regression this exists for: `parentTypes` is not ordered
    // furthest-last. Six of the fifty types classified as null under a
    // last-element rule and would have silently left the space.
    expect(PROFILE_TYPES.medical_need.parentTypes).toEqual(['individual', 'family'])
    expect(entityRoot('medical_need')).toBe('individual')
    expect(PROFILE_TYPES.regional_planning_agency.parentTypes).toEqual(['public_agency', 'local_government'])
    expect(entityRoot('regional_planning_agency')).toBe('public_agency')
    // …and the last-element rule really would have failed:
    const lastParent = (id) => PROFILE_TYPES[id].parentTypes.at(-1)
    expect(ROOT_CLASS[lastParent('medical_need')]).toBeUndefined()
    expect(ROOT_CLASS[lastParent('regional_planning_agency')]).toBeUndefined()
  })

  it('puts people on the individual side and institutions on the org side', () => {
    expect(entityClass('veteran')).toBe('individual')
    expect(entityClass('graduate_student')).toBe('individual')
    expect(entityClass('classroom_teacher')).toBe('individual')
    expect(entityClass('school_district')).toBe('org')
    expect(entityClass('domestic_violence_shelter')).toBe('org')
    expect(entityClass('minority_owned_business')).toBe('org')
  })
})

describe('need axis — total classification, no hand-typed subset', () => {
  it('assigns a ROLE to every group the registry declares', () => {
    const undeclared = OBSERVED_NEED_GROUPS.filter((g) => !NEED_GROUP_ROLE[g])
    expect(undeclared).toEqual([])
  })

  it('declares applicability for EVERY canonical need, and nothing else', () => {
    const registryIds = CANONICAL_NEED_CATEGORIES.map((n) => n.id)
    const missing = registryIds.filter((id) => !NEED_APPLICABILITY[id])
    const extra = Object.keys(NEED_APPLICABILITY).filter((id) => !registryIds.includes(id))
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })

  it('uses only the values the plausibility gate understands', () => {
    for (const [id, value] of Object.entries(NEED_APPLICABILITY)) {
      expect(['individual', 'org', 'both'], `${id}`).toContain(value)
    }
  })

  it('keeps population and organization ids OFF the need axis', () => {
    // They live on the identity and entity axes respectively; leaving them here
    // produced measurably incoherent probes ("an animal rescue that needs
    // women").
    for (const row of CANONICAL_NEED_CATEGORIES) {
      if (NEED_GROUP_ROLE[row.group] === 'need') expect(NEED_IDS).toContain(row.id)
      else expect(NEED_IDS).not.toContain(row.id)
    }
  })
})

describe('identity axis — read out of the canonical flag registries', () => {
  it('carries every canonical health diagnosis flag', () => {
    for (const flag of HEALTH_DIAGNOSIS_FLAGS) {
      expect(IDENTITY_IDS).toContain(`health:${flag}`)
    }
  })

  it('keeps `none` reachable — the commonest real profile declares nothing', () => {
    expect(IDENTITY_IDS).toContain('none')
    expect(identityParts('none')).toEqual({ kind: 'none', token: null })
    expect(identityParts('health:hiv')).toEqual({ kind: 'health', token: 'hiv' })
    expect(identityParts('veteran')).toEqual({ kind: 'population', token: 'veteran' })
  })
})

describe('geography axis — all 50 states + DC, not ten cities', () => {
  it('has a locality for EVERY state in the canonical registry', () => {
    const missing = STATE_IDS.filter((s) => !LOCALITIES[s])
    expect(missing).toEqual([])
    expect(STATE_IDS.length).toBe(Object.keys(STATE_REGISTRY).length)
    expect(STATE_IDS.length).toBeGreaterThanOrEqual(51)
  })

  it('has no locality for a state the registry does not know', () => {
    const extra = Object.keys(LOCALITIES).filter((s) => !STATE_IDS.includes(s))
    expect(extra).toEqual([])
  })

  it('gives every locality a real city, county and 5-digit ZIP', () => {
    for (const [state, loc] of Object.entries(LOCALITIES)) {
      expect(loc.city, state).toBeTruthy()
      expect(loc.county, state).toBeTruthy()
      expect(String(loc.zip), state).toMatch(/^\d{5}$/)
    }
  })

  it('never invents a locality for an unknown state', () => {
    expect(localityFor('ZZ')).toBeNull()
    expect(localityFor(null)).toBeNull()
    expect(localityFor('wv')).toMatchObject({ state: 'WV', county: 'Raleigh' })
  })
})

describe('cells and pairs', () => {
  const cell = { entity: 'veteran', identity: 'health:tbi', need: 'business', state: 'WV' }

  it('round-trips a cell key', () => {
    expect(parseCellKey(cellKey(cell))).toEqual(cell)
    expect(parseCellKey('garbage')).toBeNull()
  })

  it('emits exactly the six unordered axis pairs', () => {
    const pairs = cellPairs(cell)
    expect(pairs).toHaveLength(6)
    expect(new Set(pairs).size).toBe(6)
    expect(pairs).toContain('entity:veteran~state:WV')
  })

  it('accepts a real intersection and refuses an incoherent one', () => {
    expect(isPlausibleCell(cell)).toBe(true)
    // cash_assistance is individual-only: a school district does not apply for it.
    expect(isPlausibleCell({ entity: 'school_district', identity: 'none', need: 'cash_assistance', state: 'TN' })).toBe(false)
    expect(isPlausibleCell({ entity: 'nope', identity: 'none', need: 'housing', state: 'TN' })).toBe(false)
    expect(isPlausibleCell({ entity: 'veteran', identity: 'none', need: 'housing', state: 'ZZ' })).toBe(false)
  })

  it('lets an ORG carry an identity — it SERVES the population', () => {
    // This is the intersection the single-axis catalog could never reach.
    expect(isPlausibleCell({ entity: 'mental_health_nonprofit', identity: 'health:cancer', need: 'health_medical', state: 'OH' })).toBe(true)
  })
})

describe('the convergence denominator is real', () => {
  it('counts only pairs a PLAUSIBLE cell can actually reach', () => {
    const reachable = enumerateReachablePairs()
    // An implausible entity~need pair must not be in the denominator, or 100%
    // coverage would be unattainable and the metric decorative.
    expect(reachable.has('entity:school_district~need:cash_assistance')).toBe(false)
    expect(reachable.has('entity:individual~need:cash_assistance')).toBe(true)
    expect(reachablePairCount()).toBe(reachable.size)
    expect(reachablePairCount()).toBeGreaterThan(5000)
  })

  it('every pair of a plausible cell is in the denominator', () => {
    const c = { entity: 'food_pantry', identity: 'immigrant_refugee', need: 'food', state: 'NM' }
    expect(isPlausibleCell(c)).toBe(true)
    const reachable = enumerateReachablePairs()
    for (const p of cellPairs(c)) expect(reachable.has(p), p).toBe(true)
  })
})
