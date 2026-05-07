/**
 * Unit tests — backend/services/profileTypeRegistry.js
 *
 * The profile-type registry is the single contract that lets every other
 * subsystem (signal extraction, source plan, strategy dispatch, Anya
 * narration) reason about a profile by its canonical id rather than ad-hoc
 * string matching. These tests lock in the basic contract so future
 * additions can't silently break consumers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_TYPES,
  resolveProfileType,
  getProfileType,
  listProfileTypes,
  getParentChain,
  recommendStrategyFor,
  recommendedSourcesFor,
  defaultNeedsFor,
} from '../../backend/services/profileTypeRegistry.js'

import { SOURCES } from '../../backend/services/sourceRegistry.js'

test('profileTypeRegistry: every entry declares the required contract fields', () => {
  for (const entry of listProfileTypes()) {
    assert.ok(entry.id, 'id required')
    assert.ok(Array.isArray(entry.aliases), `${entry.id}: aliases must be an array`)
    assert.ok(Array.isArray(entry.parentTypes), `${entry.id}: parentTypes must be an array`)
    assert.ok(Array.isArray(entry.defaultNeeds), `${entry.id}: defaultNeeds must be an array`)
    assert.ok(Array.isArray(entry.requiredProfileFields), `${entry.id}: requiredProfileFields must be an array`)
    assert.ok(Array.isArray(entry.recommendedSources), `${entry.id}: recommendedSources must be an array`)
    assert.ok(typeof entry.recommendedStrategy === 'string' && entry.recommendedStrategy.length > 0,
      `${entry.id}: recommendedStrategy must be a non-empty string`)
    assert.ok(typeof entry.anyaLabel === 'string' && entry.anyaLabel.length > 0,
      `${entry.id}: anyaLabel must be a non-empty string`)
    assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0,
      `${entry.id}: summary must be a non-empty string`)

    // Every recommended source id must exist in the source registry.
    for (const sourceId of entry.recommendedSources) {
      assert.ok(SOURCES[sourceId],
        `${entry.id}: recommendedSources entry ${sourceId} is not a valid SOURCE_ID`)
    }
  }
})

test('profileTypeRegistry: id and every alias resolve back to the same canonical id', () => {
  for (const entry of listProfileTypes()) {
    assert.equal(resolveProfileType(entry.id), entry.id, `id self-resolve: ${entry.id}`)
    for (const alias of entry.aliases) {
      assert.equal(resolveProfileType(alias), entry.id,
        `${entry.id}: alias "${alias}" must resolve to ${entry.id}`)
    }
  }
})

test('profileTypeRegistry: alias resolution is case- and punctuation-insensitive', () => {
  assert.equal(resolveProfileType('VFD'), 'volunteer_fire_department')
  assert.equal(resolveProfileType('volunteer fire'), 'volunteer_fire_department')
  assert.equal(resolveProfileType('County Government'), 'county_government')
  assert.equal(resolveProfileType('PTA'), 'pta_pto')
  assert.equal(resolveProfileType('food bank'), 'food_pantry')
  assert.equal(resolveProfileType('CITY'), 'municipality')
})

test('profileTypeRegistry: unknown types resolve to null without throwing', () => {
  assert.equal(resolveProfileType('does_not_exist'), null)
  assert.equal(resolveProfileType(''), null)
  assert.equal(resolveProfileType(null), null)
  assert.equal(resolveProfileType(undefined), null)
})

test('profileTypeRegistry: getProfileType returns the canonical entry', () => {
  const entry = getProfileType('vfd')
  assert.ok(entry)
  assert.equal(entry.id, 'volunteer_fire_department')
  assert.ok(entry.recommendedSources.length >= 3)
})

test('profileTypeRegistry: parent chain walks ancestors depth-first', () => {
  const chain = getParentChain('classroom_teacher')
  assert.ok(chain.includes('teacher'), `parents include teacher: ${JSON.stringify(chain)}`)
  assert.ok(chain.includes('educator'), `parents include educator: ${JSON.stringify(chain)}`)
})

test('profileTypeRegistry: recommendStrategyFor inherits from parent when needed', () => {
  // pta_pto declares its own strategy
  assert.equal(recommendStrategyFor('pta_pto'), 'teacher_classroom')
  // domestic_violence_shelter inherits from homeless_shelter
  assert.equal(recommendStrategyFor('domestic_violence_shelter'), 'homeless_services')
  // unknown falls back to comprehensive (mission rule: always plan something)
  assert.equal(recommendStrategyFor('does_not_exist'), 'comprehensive')
})

test('profileTypeRegistry: recommendedSourcesFor returns ≥ 3 sources for each named gap profile', () => {
  // These are the profile types the user explicitly called out as needing
  // coverage. They must each have at least 3 recommended sources so the
  // downstream coverage planner has something concrete to seed the plan
  // with even before need-detection runs.
  const REQUIRED = [
    'county_government',
    'municipality',
    'tribal_government',
    'public_school',
    'school_district',
    'teacher',
    'classroom_teacher',
    'public_health_department',
    'library',
    'parks_department',
    'animal_rescue',
    'food_pantry',
    'homeless_shelter',
    'volunteer_fire_department',
  ]
  for (const id of REQUIRED) {
    const sources = recommendedSourcesFor(id)
    assert.ok(sources.length >= 3,
      `${id}: must recommend ≥ 3 sources (mission rule: never plan a single-source crawl). got=${JSON.stringify(sources)}`)
  }
})

test('profileTypeRegistry: defaultNeedsFor surfaces ancestor needs as well', () => {
  const teacherNeeds = defaultNeedsFor('classroom_teacher')
  assert.ok(teacherNeeds.includes('classroom_supplies'),
    `classroom_teacher inherits classroom_supplies: ${JSON.stringify(teacherNeeds)}`)
  // educator parent contributes professional_development
  assert.ok(teacherNeeds.includes('professional_development'),
    `classroom_teacher inherits professional_development from educator: ${JSON.stringify(teacherNeeds)}`)
})

test('profileTypeRegistry: every entry’s recommendedStrategy is a valid strategy id', async () => {
  const { default: strategyDefault } = await import('../../backend/services/crawlers/strategyRegistry.js')
  const strategyIds = new Set(Object.values(strategyDefault.STRATEGIES).map((s) => s.id))
  for (const entry of listProfileTypes()) {
    assert.ok(strategyIds.has(entry.recommendedStrategy),
      `${entry.id}: recommendedStrategy "${entry.recommendedStrategy}" must exist in strategyRegistry. Known: ${[...strategyIds].sort().join(', ')}`)
  }
})

test('profileTypeRegistry: parent ids exist in the registry', () => {
  const allIds = new Set(Object.keys(PROFILE_TYPES))
  for (const entry of listProfileTypes()) {
    for (const parent of entry.parentTypes) {
      assert.ok(allIds.has(parent),
        `${entry.id}: parent type "${parent}" is not registered`)
    }
  }
})
