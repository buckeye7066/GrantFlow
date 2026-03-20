/**
 * Domain Crawler Engine unit tests
 * - business_startup_grants: every item has URL, no loan/matching keywords, >= 6 directory resources
 * - another crawler (veteran_affairs): >= 6 items, all have URLs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runDomainCrawler,
  normalizeOpportunity,
  looksLikeLoan,
  looksLikeMatchingFunds,
} from '../../backend/services/crawlers/domainCrawlerEngine.js'
import { DOMAIN_CRAWLER_REGISTRY } from '../../backend/services/crawlers/domainCrawlerRegistry.js'
import { crawlDomain } from '../../backend/services/crawlers/domainCrawlers.js'

const LOAN_KEYWORDS = ['loan', 'microloan', 'repay', 'SBA loan', 'line of credit', 'lender', 'borrow']
const MATCHING_KEYWORDS = ['matching funds', 'match requirement', 'cost share', 'co-funding', 'dollar-for-dollar']

test('looksLikeLoan detects loan-related text', () => {
  for (const kw of LOAN_KEYWORDS) {
    assert.equal(looksLikeLoan(kw), true, `should detect "${kw}"`)
  }
  assert.equal(looksLikeLoan('Pure grant for startups'), false)
  assert.equal(looksLikeLoan(''), false)
  assert.equal(looksLikeLoan(null), false)
})

test('looksLikeMatchingFunds detects matching-fund text', () => {
  for (const kw of MATCHING_KEYWORDS) {
    assert.equal(looksLikeMatchingFunds(kw), true, `should detect "${kw}"`)
  }
  assert.equal(looksLikeMatchingFunds('Grant with no match'), false)
  assert.equal(looksLikeMatchingFunds(null), false)
})

test('normalizeOpportunity returns null when title or URL missing', () => {
  assert.equal(normalizeOpportunity(null), null)
  assert.equal(normalizeOpportunity({}), null)
  assert.equal(normalizeOpportunity({ title: 'Test', description: 'x' }), null)
  assert.equal(normalizeOpportunity({ url: 'https://example.com' }), null)
  assert.equal(normalizeOpportunity({ title: 'Test', url: 'not-a-url' }), null)
  assert.ok(normalizeOpportunity({ title: 'Test', url: 'https://example.com' }))
  assert.ok(normalizeOpportunity({ title: 'Test', application_url: 'https://example.com' }))
  assert.ok(normalizeOpportunity({ title: 'Test', source_url: 'https://example.com' }))
})

test('business_startup_grants: every item has url/application_url/source_url', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  assert.ok(config, 'business_startup_grants config must exist')

  const profile = {
    signals: {
      keywordSet: new Set(['startup', 'grant']),
      location: { zip: '37209', state: 'TN' },
    },
  }

  const results = await runDomainCrawler({ profile, config, options: {} })

  assert.ok(Array.isArray(results), 'results must be array')
  assert.ok(results.length >= 6, `business_startup_grants must return >= 6 items, got ${results.length}`)

  for (const opp of results) {
    const hasUrl = opp.url || opp.application_url || opp.source_url
    assert.ok(hasUrl, `every item must have URL: ${JSON.stringify(opp)}`)
    assert.ok(typeof opp.title === 'string' && opp.title.trim(), `every item must have title: ${JSON.stringify(opp)}`)
  }
})

test('business_startup_grants: no item contains loan keywords', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  const profile = { signals: { keywordSet: new Set(['startup']), location: {} } }
  const results = await runDomainCrawler({ profile, config, options: {} })

  for (const opp of results) {
    const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
      .filter(Boolean)
      .join(' ')
    assert.equal(looksLikeLoan(text), false, `no loan keywords allowed: "${opp.title}" - ${text}`)
  }
})

test('business_startup_grants: no item contains matching-fund keywords', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  const profile = { signals: { keywordSet: new Set(['startup']), location: {} } }
  const results = await runDomainCrawler({ profile, config, options: {} })

  for (const opp of results) {
    const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
      .filter(Boolean)
      .join(' ')
    assert.equal(looksLikeMatchingFunds(text), false, `no matching-fund keywords: "${opp.title}" - ${text}`)
  }
})

test('business_startup_grants: returns >= 6 directory resources', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  const profile = { signals: { keywordSet: new Set(), location: {} } }
  const results = await runDomainCrawler({ profile, config, options: {} })

  const directoryCount = results.filter((r) => r.record_origin === 'directory_resource').length
  assert.ok(
    directoryCount >= 6,
    `business_startup_grants must return >= 6 directory resources, got ${directoryCount}`,
  )
})

test('veteran_affairs: returns >= 6 items, all have URLs', async () => {
  const profile = {
    signals: {
      keywordSet: new Set(['veteran']),
      location: { state: 'TN' },
    },
  }

  const results = await crawlDomain(profile, 'veteran_affairs', {})

  assert.ok(Array.isArray(results), 'results must be array')
  assert.ok(results.length >= 6, `veteran_affairs must return >= 6 items, got ${results.length}`)

  for (const opp of results) {
    const hasUrl = opp.url || opp.application_url || opp.source_url
    assert.ok(hasUrl, `every item must have URL: ${JSON.stringify(opp)}`)
    assert.ok(typeof opp.title === 'string' && opp.title.trim(), `every item must have title`)
  }
})

test('runDomainCrawler with null profile returns empty array', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY[0]
  const results = await runDomainCrawler({ profile: null, config, options: {} })
  assert.deepEqual(results, [])
})

test('crawlDomain with unknown type returns empty array', async () => {
  const profile = { signals: { keywordSet: new Set(), location: {} } }
  const results = await crawlDomain(profile, 'unknown_crawler_xyz', {})
  assert.deepEqual(results, [])
})
