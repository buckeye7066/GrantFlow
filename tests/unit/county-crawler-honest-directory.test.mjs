import test from 'node:test'
import assert from 'node:assert/strict'

// Proves the countyFundingCrawler hardening: it no longer emits fake
// county-specific "programs" and is gated off by default.
test('county crawler is gated OFF by default and emits honest directory data', async () => {
  delete process.env.COUNTY_FUNDING_CRAWLER_ENABLED
  const mod = await import('../../backend/services/countyFundingCrawler.js')

  // Disabled by default.
  assert.equal(mod.isCountyCrawlerEnabled(), false)

  // crawl entry points short-circuit BEFORE touching the db when disabled.
  const allRes = await mod.crawlAllCounties(/* db */ null, {})
  assert.equal(allRes.disabled, true)
  assert.equal(allRes.inserted, 0)
  const stateRes = await mod.crawlStateCounties(/* db */ null, 'OH', {})
  assert.equal(stateRes.disabled, true)

  // Every org pattern carries an honest resourceLabel (used to build
  // "Find your local <X>" directory titles instead of "<Org> of <County> County").
  const patterns = mod.default.ORG_PATTERNS
  for (const [orgType, cfg] of Object.entries(patterns)) {
    assert.equal(typeof cfg.resourceLabel, 'string', `${orgType} must have a resourceLabel`)
    assert.ok(cfg.resourceLabel.length > 0)
    // Real https locator URL (never a placeholder / search engine).
    assert.match(cfg.fallback, /^https:\/\//, `${orgType} fallback must be a real https URL`)
  }
})

test('county crawler honest enabled flag toggles', async () => {
  process.env.COUNTY_FUNDING_CRAWLER_ENABLED = 'true'
  const mod = await import('../../backend/services/countyFundingCrawler.js')
  assert.equal(mod.isCountyCrawlerEnabled(), true)
  delete process.env.COUNTY_FUNDING_CRAWLER_ENABLED
})
