/**
 * Unit tests — shared/profileTypeToClientCategory.js
 *
 * Locks the single mapping from a profile's TYPE taxonomy to a BILLING client
 * category ('individual' | 'small' | 'mid' | 'large') so backend billing and
 * the frontend profile UI can never derive a different tier for the same
 * profile type. Covers each canonical type, the org annual-budget thresholds,
 * and legacy / odd-type fallback.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  profileTypeToClientCategory,
  orgCategoryForBudget,
  parseAnnualBudget,
  ORG_BUDGET_THRESHOLDS,
  CLIENT_CATEGORIES,
} from '../../shared/profileTypeToClientCategory.js'

import { CLIENT_CATEGORY_BUDGET_THRESHOLDS } from '../../backend/services/pricing/pricingTypes.js'

test('thresholds match the pricing engine source-of-truth (no drift)', () => {
  assert.equal(ORG_BUDGET_THRESHOLDS.small_max, CLIENT_CATEGORY_BUDGET_THRESHOLDS.small_max)
  assert.equal(ORG_BUDGET_THRESHOLDS.mid_max, CLIENT_CATEGORY_BUDGET_THRESHOLDS.mid_size_max)
})

test('category keys are exactly the 4-code catalog categories', () => {
  assert.deepEqual([...CLIENT_CATEGORIES], ['individual', 'small', 'mid', 'large'])
})

test('individual-tier types all map to individual (regardless of budget)', () => {
  const types = [
    'individual',
    'family',
    'student',
    'homeschool_family',
    'medical', // canonical UI value
    'medical_need', // registry id
    'medical_assistance', // legacy alias
    'high_school_student',
    'college_student',
    'graduate_student',
  ]
  for (const primaryType of types) {
    assert.equal(
      profileTypeToClientCategory({ primaryType }),
      'individual',
      `${primaryType} should be individual`,
    )
    // Even an absurd budget must not promote an individual type.
    assert.equal(
      profileTypeToClientCategory({ primaryType, annualBudget: 9_000_000 }),
      'individual',
      `${primaryType} stays individual even with a large budget`,
    )
  }
})

test('organization buckets by annual budget — Small / Mid / Large', () => {
  // Under $250k → small.
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 0 }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 249_999 }), 'small')
  // $250k boundary is the start of the mid band ($250k–$2M).
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 250_000 }), 'mid')
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 2_000_000 }), 'mid')
  // Over $2M → large.
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 2_000_001 }), 'large')
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: 50_000_000 }), 'large')
})

test('nonprofit is a TOP-LEVEL type that tiers as an organization by budget', () => {
  // Owner decision: Nonprofit is its own top-level primary_type but tiers like
  // any organization — small / mid / large by the org's annual budget, with an
  // unknown budget defaulting to small. No org sub-type is required.
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit' }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 120_000 }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 249_999 }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 250_000 }), 'mid')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 900_000 }), 'mid')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 2_000_000 }), 'mid')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 2_000_001 }), 'large')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: 5_000_000 }), 'large')
  // Faith/community nonprofits (church/ministry) tier the same way.
  assert.equal(profileTypeToClientCategory({ primaryType: 'church', annualBudget: 5_000_000 }), 'large')
  assert.equal(profileTypeToClientCategory({ primaryType: 'ministry' }), 'small')
})

test('organization with unknown budget defaults to small', () => {
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization' }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'nonprofit', annualBudget: null }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'business', annualBudget: '' }), 'small')
})

test('org sub-types (nonprofit / business / school) are organizations', () => {
  // Generic / unknown primary type + an explicit org sub-type → org bucketing.
  assert.equal(profileTypeToClientCategory({ primaryType: '', orgSubtype: 'nonprofit' }), 'small')
  assert.equal(
    profileTypeToClientCategory({ primaryType: 'other', orgSubtype: 'business', annualBudget: 500_000 }),
    'mid',
  )
  assert.equal(
    profileTypeToClientCategory({ primaryType: 'other', orgSubtype: 'school', annualBudget: 5_000_000 }),
    'large',
  )
})

test('formatted budget strings are parsed', () => {
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: '$1,250,000' }), 'mid')
  assert.equal(profileTypeToClientCategory({ primaryType: 'organization', annualBudget: '300000' }), 'mid')
  assert.equal(orgCategoryForBudget('$100,000'), 'small')
  assert.equal(parseAnnualBudget('$2,500,000'), 2_500_000)
  assert.equal(parseAnnualBudget('not a number'), null)
  assert.equal(parseAnnualBudget(null), null)
})

test('Other defaults to individual unless marked an organization', () => {
  assert.equal(profileTypeToClientCategory({ primaryType: 'other' }), 'individual')
  // A budget alone does NOT promote 'other' to an org.
  assert.equal(profileTypeToClientCategory({ primaryType: 'other', annualBudget: 5_000_000 }), 'individual')
  // But an org sub-type does.
  assert.equal(
    profileTypeToClientCategory({ primaryType: 'other', orgSubtype: 'nonprofit', annualBudget: 5_000_000 }),
    'large',
  )
})

test('legacy / odd / mistyped types fall back sensibly (never crash)', () => {
  // A student mistyped as caregiver/individual must still bill as individual.
  assert.equal(profileTypeToClientCategory({ primaryType: 'caregiver' }), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: 'senior' }), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: 'veteran' }), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: 'disabled_adult' }), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: 'individual_need' }), 'individual')
  // Completely unknown type → individual (cheapest, safest default).
  assert.equal(profileTypeToClientCategory({ primaryType: 'totally_made_up_type' }), 'individual')
  // Empty / missing input → individual; no throw.
  assert.equal(profileTypeToClientCategory({}), 'individual')
  assert.equal(profileTypeToClientCategory(), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: null }), 'individual')
})

test('case- and punctuation-insensitive on the primary type', () => {
  assert.equal(profileTypeToClientCategory({ primaryType: 'Homeschool Family' }), 'individual')
  assert.equal(profileTypeToClientCategory({ primaryType: 'ORGANIZATION', annualBudget: 100 }), 'small')
  assert.equal(profileTypeToClientCategory({ primaryType: 'Small Business' }), 'small')
})
