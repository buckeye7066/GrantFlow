import test from 'node:test'
import assert from 'node:assert/strict'

import { planCrawlerQueries } from '../../backend/services/crawlers/queryPlanner.js'

test('query planner: food truck startup intent excludes food-bank terms', () => {
  const facets = {
    profile: {
      primary_profile_type: 'small_business',
      applicant_types: ['small_business'],
    },
    geo: {
      city: 'Nashville',
      state: 'TN',
      zip: '37209',
    },
    occupation: {
      small_business_owner: true,
    },
    assistance: {},
    intent: {
      primary_need_category: 'business_startup',
      keywords: ['food truck', 'mobile food business', 'startup grant'],
      negative_keywords: [],
    },
  }

  const plan = planCrawlerQueries({
    crawlerType: 'local_funding',
    facets,
    location: facets.geo,
  })

  assert.ok(plan.mustTerms.includes('food truck grant'))
  assert.ok(plan.mustNotTerms.includes('food bank'))
  assert.ok(plan.mustNotTerms.includes('food pantry'))
  assert.ok(plan.requiredConcepts.includes('business funding'))
  assert.ok(plan.shouldTerms.some((term) => term.includes('nashville')))
})

test('query planner: food security intent excludes restaurant startup noise', () => {
  const facets = {
    profile: {
      primary_profile_type: 'individual_need',
      applicant_types: ['individual_need'],
    },
    geo: {
      state: 'OH',
      zip: '44089',
    },
    occupation: {},
    assistance: {
      snap_recipient: true,
    },
    intent: {
      primary_need_category: 'food_security',
      keywords: ['food pantry', 'nutrition support'],
      negative_keywords: [],
    },
  }

  const plan = planCrawlerQueries({
    crawlerType: 'local_funding',
    facets,
    location: facets.geo,
  })

  assert.ok(plan.shouldTerms.includes('food assistance'))
  assert.ok(plan.mustNotTerms.includes('food truck startup'))
  assert.ok(plan.mustNotTerms.includes('restaurant franchise'))
  assert.ok(plan.requiredConcepts.includes('state_or_national_match'))
})

test('query planner: ECF benefits include TN analog terms and sponsors', () => {
  const facets = {
    profile: {
      primary_profile_type: 'medical_assistance',
      applicant_types: ['medical_assistance'],
    },
    geo: {
      state: 'TN',
      zip: '37209',
    },
    occupation: {},
    assistance: {
      medicaid_waiver_program: 'ecf_choices',
      ecf_choices_role: 'participant',
    },
    intent: {
      primary_need_category: 'disability_support',
      keywords: ['ecf choices', 'community first'],
      negative_keywords: [],
    },
  }

  const plan = planCrawlerQueries({
    crawlerType: 'ecf_benefits',
    facets,
    location: facets.geo,
  })

  assert.ok(plan.mustTerms.includes('medicaid waiver'))
  assert.ok(plan.shouldTerms.includes('employment and community first choices'))
  assert.ok(plan.shouldTerms.includes('didd services'))
  assert.ok(plan.preferredSponsors.includes('tenncare'))
  assert.ok(plan.authorityDomainsAllowlist.includes('medicaid.gov'))
  assert.ok(plan.authorityDomainsBlocklist.includes('facebook.com'))
})

test('query planner: nurse licensure intent adds workforce training concepts', () => {
  const facets = {
    profile: {
      primary_profile_type: 'individual_need',
      applicant_types: ['individual_need'],
    },
    geo: {
      state: 'CA',
    },
    occupation: {
      healthcare_worker: true,
    },
    assistance: {},
    intent: {
      primary_need_category: 'education',
      keywords: ['nurse licensure', 'nclex prep', 'nursing scholarship'],
      negative_keywords: [],
    },
  }

  const plan = planCrawlerQueries({
    crawlerType: 'student_grants',
    facets,
    location: facets.geo,
  })

  assert.ok(plan.shouldTerms.includes('nurse licensure training grant'))
  assert.ok(plan.shouldTerms.includes('nclex prep assistance'))
  assert.ok(plan.requiredConcepts.includes('workforce training'))
})
