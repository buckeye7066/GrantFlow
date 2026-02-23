import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enforceCrawlerOpportunityContract,
  mergePlanKeywords,
  violatesMustNot,
} from '../../backend/services/crawlers/crawlerOpportunityContract.js'

test('crawler opportunity contract: normalizes valid opportunity shape', () => {
  const normalized = enforceCrawlerOpportunityContract(
    {
      title: 'Teacher Classroom Mini Grant',
      description: 'Funding for classroom supplies and curriculum materials',
      url: 'https://www.grants.gov/sample-teacher-mini-grant',
      categories: ['Education', 'education'],
      keywords: ['Teacher', 'classroom supplies', 'Teacher'],
      eligibility: 'Open to K-12 teachers; Public schools only',
      opportunity_type: 'program',
      match_reasons: ['Existing match reason'],
    },
    {
      crawlerType: 'student_grants',
      sourceFallback: 'student_grants',
      facets: {
        profile: { primary_profile_type: 'educator' },
        geo: { state: 'TN' },
        intent: { primary_need_category: 'education' },
      },
      queryPlan: {
        mustNotTerms: [],
      },
    },
  )

  assert.ok(normalized)
  assert.equal(normalized.title, 'Teacher Classroom Mini Grant')
  assert.equal(normalized.source_url, 'https://www.grants.gov/sample-teacher-mini-grant')
  assert.equal(normalized.application_url, 'https://www.grants.gov/sample-teacher-mini-grant')
  assert.equal(normalized.record_origin, 'directory_resource')
  assert.deepEqual(normalized.categories, ['Education'])
  assert.deepEqual(normalized.keywords, ['Teacher', 'classroom supplies'])
  assert.ok(Array.isArray(normalized.eligibility_bullets))
  assert.ok(normalized.match_reasons.some((reason) => String(reason).includes('Intent category: education')))
})

test('crawler opportunity contract: rejects items violating must-not terms', () => {
  const rejected = enforceCrawlerOpportunityContract(
    {
      title: 'Neighborhood Food Bank Directory',
      description: 'Find food bank and pantry locations near you',
      url: 'https://www.feedingamerica.org/find-your-local-foodbank',
    },
    {
      crawlerType: 'local_funding',
      queryPlan: {
        mustNotTerms: ['food bank', 'food pantry'],
      },
    },
  )
  assert.equal(rejected, null)
})

test('crawler opportunity contract: rejects invalid URLs and missing titles', () => {
  const noTitle = enforceCrawlerOpportunityContract(
    {
      url: 'https://www.grants.gov/valid',
      description: 'Missing title should reject',
    },
    { crawlerType: 'government_funding' },
  )
  assert.equal(noTitle, null)

  const badUrl = enforceCrawlerOpportunityContract(
    {
      title: 'Bad URL Program',
      url: 'ftp://invalid-url.test',
      description: 'FTP urls are rejected',
    },
    { crawlerType: 'government_funding' },
  )
  assert.equal(badUrl, null)
})

test('crawler opportunity contract helpers: must-not detection and keyword merge are deterministic', () => {
  const blocked = violatesMustNot(
    {
      title: 'Stock option strike price planning',
      description: 'General finance resource',
      keywords: ['options'],
      categories: ['finance'],
    },
    { mustNotTerms: ['stock option strike price'] },
  )
  assert.equal(blocked, true)

  const merged = mergePlanKeywords(
    ['Grant', 'grant'],
    {
      mustTerms: ['startup'],
      shouldTerms: ['grant', 'Startup'],
    },
  )
  assert.deepEqual(
    merged.map((value) => String(value).toLowerCase()),
    ['grant', 'startup'],
  )
})
