import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  areDuplicateFundingResults,
  dedupeFundingResults,
  normalizeFundingUrl,
} from '../../src/utils/fundingDedupe.js'

test('funding result dedupe collapses NAEMT scholarship crawler variants', () => {
  const variants = [
    {
      id: 'web-1',
      title: 'NAEMT Educational Scholarships',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Individual active NAEMT members pursuing EMT-Basic, EMT-Paramedic, or continuing EMS education.',
      match_score: 79,
      source: 'web_llm',
    },
    {
      id: 'web-2',
      title: 'NAEMT Educational Scholarship - Paramedic',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Active NAEMT paramedic members pursuing continuing EMS education.',
      match_score: 82,
      source: 'web_llm',
    },
    {
      id: 'web-3',
      title: 'NAEMT EMT-Paramedic Scholarship',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Active NAEMT members pursuing EMT-Paramedic education.',
      match_score: 82,
      source: 'web_llm',
    },
  ]

  const deduped = dedupeFundingResults(variants)

  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].match_score, 82)
})

test('funding result dedupe does not collapse distinct same-funder programs', () => {
  const rows = [
    {
      id: 'usda-1',
      title: 'USDA Value Added Producer Grant',
      sponsor: 'USDA Rural Development',
      description: 'Planning and working capital grants for value-added agricultural products.',
      match_score: 84,
    },
    {
      id: 'usda-2',
      title: 'USDA REAP Grant',
      sponsor: 'USDA Rural Development',
      description: 'Renewable energy and energy efficiency assistance for rural businesses and producers.',
      match_score: 81,
    },
  ]

  assert.equal(areDuplicateFundingResults(rows[0], rows[1]), false)
  assert.equal(dedupeFundingResults(rows).length, 2)
})

test('funding result dedupe collapses stable URLs even when crawler ids differ', () => {
  const rows = [
    {
      id: 'crawl-a',
      title: 'Community Scholarship',
      sponsor: 'Example Foundation',
      application_url: 'https://example.org/apply?utm_source=crawler',
      match_score: 70,
    },
    {
      id: 'crawl-b',
      title: 'Community Scholarship Program',
      sponsor: 'Example Foundation',
      application_url: 'https://example.org/apply',
      match_score: 75,
    },
  ]

  assert.equal(normalizeFundingUrl(rows[0].application_url), normalizeFundingUrl(rows[1].application_url))
  const deduped = dedupeFundingResults(rows)
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].match_score, 75)
})

test('funding result dedupe does not collapse distinct programs on a shared landing page', () => {
  const rows = [
    {
      id: 'state-fund',
      title: 'Tennessee Emergency Fund',
      sponsor: 'Example Foundation',
      description: 'State emergency assistance for Tennessee residents.',
      source_url: 'https://example.org/grants',
      match_score: 74,
    },
    {
      id: 'national-fund',
      title: 'National Emergency Fund',
      sponsor: 'Example Foundation',
      description: 'National emergency assistance program.',
      source_url: 'https://example.org/grants?utm_source=crawler',
      match_score: 70,
    },
  ]

  assert.equal(normalizeFundingUrl(rows[0].source_url), normalizeFundingUrl(rows[1].source_url))
  assert.equal(areDuplicateFundingResults(rows[0], rows[1]), false)
  assert.equal(dedupeFundingResults(rows).length, 2)
})

test('funding result dedupe does not collapse numbered programs on a shared landing page', () => {
  const rows = [
    {
      id: 'os-rich-1',
      title: 'Rich OS Grant 1',
      sponsor: 'Foundation',
      source_url: 'https://www.grants.gov/y',
      match_score: 76,
    },
    {
      id: 'os-rich-2',
      title: 'Rich OS Grant 2',
      sponsor: 'Foundation',
      source_url: 'https://www.grants.gov/y',
      match_score: 77,
    },
  ]

  assert.equal(areDuplicateFundingResults(rows[0], rows[1]), false)
  assert.equal(dedupeFundingResults(rows).length, 2)
})

test('funding result dedupe collapses canonical catalog identity fields', () => {
  const rows = [
    {
      id: 'catalog-a',
      title: 'Ohio Classroom Mini Grant',
      sponsor: 'Example Education Fund',
      canonical_opportunity_key: 'example:ohio-classroom-mini-grant',
      match_score: 76,
    },
    {
      id: 'catalog-b',
      title: 'Ohio Classroom Mini-Grant Program',
      sponsor: 'Example Education Fund',
      canonical_opportunity_key: 'example:ohio-classroom-mini-grant',
      match_score: 82,
    },
  ]

  const deduped = dedupeFundingResults(rows)
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].match_score, 82)
})

test('funding result dedupe does not collapse generic acronym umbrella titles without evidence overlap', () => {
  const rows = [
    {
      id: 'usda-generic',
      title: 'USDA Grants',
      sponsor: 'USDA Rural Development',
      description: 'General information about USDA grant programs and application resources.',
      match_score: 84,
    },
    {
      id: 'usda-reap',
      title: 'USDA REAP Grant',
      sponsor: 'USDA Rural Development',
      description: 'Renewable energy and energy efficiency assistance for rural businesses and producers.',
      match_score: 81,
    },
  ]

  assert.equal(areDuplicateFundingResults(rows[0], rows[1]), false)
  assert.equal(dedupeFundingResults(rows).length, 2)
})
