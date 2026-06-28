import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalResultForProfile,
  canonicalizeOpportunityList,
} from '../../backend/services/matching/resultEnricher.js'

test('canonicalResultForProfile rejects profile-inappropriate exclusive business opportunity', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: ['housing'],
  }

  const opp = {
    title: 'Small Business Growth Grant',
    description: 'Eligible applicants are small businesses and entrepreneurs only.',
    application_url: 'https://sba.gov/grants',
    is_national: 1,
    categories: '["business"]',
    keywords: '["small business", "entrepreneur"]',
    // Explicit eligibility flag — engine respects this as a hard
    // disqualification for non-business profiles regardless of phrasing.
    requires_business: true,
  }

  const result = canonicalResultForProfile(profile, opp)

  assert.equal(result.display, false)
  assert.equal(result.dropReason, 'entity_business_sba')
  assert.equal(result.decision, null)
  assert.equal(result.profileGate.pass, false)
})

test('canonicalResultForProfile returns canonical fields for a true housing match', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    postal_code: '44022',
    needs: ['housing', 'utilities'],
  }

  const opp = {
    title: 'Ohio Emergency Rent and Utility Assistance',
    description: 'Emergency rent, eviction prevention, and utility assistance for Ohio residents.',
    application_url: 'https://ohio.gov/rent-help',
    state: 'OH',
    is_national: 0,
    categories: '["housing", "utilities"]',
    keywords: '["rent", "eviction", "utility assistance"]',
    is_loan: 0,
  }

  const result = canonicalResultForProfile(profile, opp)

  assert.equal(result.display, true)
  assert.ok(result.opportunity.match_score >= 50, `score=${result.opportunity.match_score}`)
  assert.ok(['ACCEPT', 'REVIEW'].includes(result.opportunity.match_decision))
  assert.ok(Array.isArray(result.opportunity.matched_profile_facts))
  assert.ok(result.opportunity.matched_profile_facts.length > 0)
  assert.ok(result.opportunity.actionable_url || result.opportunity.url)
})

test('canonicalizeOpportunityList sorts by canonical score and reports drops', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: ['housing'],
  }

  const rows = [
    {
      title: 'Business Only Grant',
      description: 'Eligible applicants are small businesses only.',
      application_url: 'https://sba.gov/grants',
      is_national: 1,
      categories: '["business"]',
      requires_business: true,
    },
    {
      title: 'Ohio Rent Help',
      description: 'Rent and eviction help for Ohio residents.',
      application_url: 'https://ohio.gov/rent',
      state: 'OH',
      categories: '["housing"]',
      keywords: '["rent"]',
    },
  ]

  const { kept, dropped } = canonicalizeOpportunityList(profile, rows)

  assert.equal(kept.length, 1)
  assert.equal(kept[0].title, 'Ohio Rent Help')
  assert.ok(dropped.decision >= 1)
})
