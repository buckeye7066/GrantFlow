import { test } from 'node:test'
import assert from 'node:assert/strict'

import { interpretProfileNeeds } from '../../backend/services/profileNeedsInterpreter.js'
import {
  DEFAULT_MIN_SCORE,
  SCORE_SCALE_ID,
} from '../../backend/config/matchThresholds.js'

/**
 * Regression tests for backend/services/profileNeedsInterpreter.js
 *
 * The interpreter feeds:
 *   - Anya Match Scout (which writes `need_summary` on every suggestion),
 *   - the Anya prompt builder (`profileNeeds` block),
 *   - future Discover Grants / Pipeline / printable-packet hints.
 *
 * It must be deterministic (same input → same output) and must hit at
 * least one need per major profile type so the Match Scout has something
 * to anchor every suggestion to.
 */

function findNeed(needs, key) {
  return needs.find((n) => n.key === key) || null
}

test('housing section + rent_help tag emits housing_stability need with searchTerms', () => {
  const { primaryNeeds, suggestedSearches, missingProfileDetails } = interpretProfileNeeds({
    profile: { state: 'TN', zip: '37601', tags: ['rent_help'] },
    sections: {
      housing: { housing_situation: 'unstable' },
      basic_information: {},
    },
  })
  const housing = findNeed(primaryNeeds, 'housing_stability')
  assert.ok(housing, 'housing_stability need should be present')
  assert.ok(housing.searchTerms.includes('rent relief'))
  assert.equal(housing.grantflowSearch.route, 'DiscoverGrants')
  assert.equal(housing.grantflowSearch.filters.category, 'housing')
  assert.equal(housing.grantflowSearch.filters.minScore, DEFAULT_MIN_SCORE)
  assert.equal(housing.grantflowSearch.filters.score_scale_id, SCORE_SCALE_ID)
  assert.ok(suggestedSearches.find((s) => s.title.toLowerCase().includes('housing')))
  // monthly housing cost missing should show up as a missing detail
  assert.ok(missingProfileDetails.find((m) => m.field === 'monthly housing cost'))
})

test('student profile w/ school populated emits student_aid need and no missing-school flag', () => {
  const { primaryNeeds, missingProfileDetails } = interpretProfileNeeds({
    profile: { primary_type: 'student', state: 'TN', zip: '37601' },
    sections: {
      education: { school_name: 'MTSU', classification: 'undergraduate' },
    },
  })
  assert.ok(findNeed(primaryNeeds, 'student_aid'), 'student_aid present')
  assert.equal(
    missingProfileDetails.find((m) => m.section_key === 'education'),
    undefined,
    'should not flag missing school when school_name is set',
  )
})

test('nonprofit ministry without EIN emits nonprofit_capacity + EIN missing detail', () => {
  const { primaryNeeds, missingProfileDetails } = interpretProfileNeeds({
    profile: { primary_type: 'church_ministry', state: 'OH' },
    sections: {
      nonprofit_compliance: { tax_status: '501c3' },
    },
  })
  assert.ok(findNeed(primaryNeeds, 'nonprofit_capacity'))
  assert.ok(
    missingProfileDetails.find((m) => m.section_key === 'nonprofit_compliance' && m.field === 'EIN'),
    'nonprofit EIN missing detail should be present',
  )
})

test('local_state_programs always emerges when state OR zip is set', () => {
  const a = interpretProfileNeeds({
    profile: { state: 'TX' },
    sections: {},
  })
  assert.ok(findNeed(a.primaryNeeds, 'local_state_programs'), 'state alone is enough')

  const b = interpretProfileNeeds({
    profile: { zip: '37601' },
    sections: {},
  })
  assert.ok(findNeed(b.primaryNeeds, 'local_state_programs'), 'zip alone is enough')

  const c = interpretProfileNeeds({ profile: {}, sections: {} })
  assert.equal(
    findNeed(c.primaryNeeds, 'local_state_programs'),
    null,
    'no location → no local need',
  )
})

test('emergency tag forces urgent_emergency need', () => {
  const { primaryNeeds } = interpretProfileNeeds({
    profile: { tags: ['emergency'] },
    sections: {},
  })
  assert.ok(findNeed(primaryNeeds, 'urgent_emergency'))
})

test('disability signal from medicaid waiver field is detected', () => {
  const { primaryNeeds } = interpretProfileNeeds({
    profile: {},
    sections: {
      government_assistance: { medicaid_waiver_program: 'ecf_choices' },
    },
  })
  assert.ok(findNeed(primaryNeeds, 'disability_support'))
})

test('missing state AND zip flag both fields as missing', () => {
  const { missingProfileDetails } = interpretProfileNeeds({
    profile: {},
    sections: {},
  })
  assert.ok(missingProfileDetails.find((m) => m.field === 'state'))
  assert.ok(missingProfileDetails.find((m) => m.field === 'zip'))
})

test('determinism: same input → same primaryNeeds keys & order', () => {
  const input = {
    profile: { primary_type: 'student', state: 'TN', tags: ['rent_help'] },
    sections: { education: { school_name: 'MTSU' }, housing: { rent: 800 } },
  }
  const a = interpretProfileNeeds(input)
  const b = interpretProfileNeeds(input)
  assert.deepEqual(
    a.primaryNeeds.map((n) => n.key),
    b.primaryNeeds.map((n) => n.key),
  )
})

test('every recommendation carries one current-scale minimum and a scale receipt', () => {
  const interpreted = interpretProfileNeeds({
    profile: {
      primary_type: 'student',
      state: 'TN',
      tags: ['rent_help', 'emergency'],
    },
    sections: { education: { school_name: 'MTSU' } },
  })

  assert.ok(interpreted.primaryNeeds.length > 1)
  for (const need of interpreted.primaryNeeds) {
    assert.equal(need.grantflowSearch.filters.minScore, DEFAULT_MIN_SCORE)
    assert.equal(need.grantflowSearch.filters.score_scale_id, SCORE_SCALE_ID)
    assert.equal(Object.keys(need.grantflowSearch.filters).filter((key) => key === 'minScore').length, 1)
  }
  for (const search of interpreted.suggestedSearches) {
    assert.equal(search.recommendedFilters.minScore, DEFAULT_MIN_SCORE)
    assert.equal(search.recommendedFilters.score_scale_id, SCORE_SCALE_ID)
  }
})

test('CSV string tags are split correctly (legacy profile shape)', () => {
  const { primaryNeeds } = interpretProfileNeeds({
    profile: { tags: 'housing, veteran' },
    sections: {},
  })
  assert.ok(findNeed(primaryNeeds, 'housing_stability'))
  assert.ok(findNeed(primaryNeeds, 'military_veteran'))
})
