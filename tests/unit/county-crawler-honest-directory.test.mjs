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

test('county-equivalent display labels preserve independent cities', async () => {
  const mod = await import('../../backend/services/countyFundingCrawler.js')
  assert.equal(mod.countyDisplayLabel('Richmond city'), 'Richmond city')
  assert.equal(mod.countyDisplayLabel('Baltimore City'), 'Baltimore City')
  assert.equal(mod.countyDisplayLabel('Carson City'), 'Carson City')
  assert.equal(mod.countyDisplayLabel('Orleans Parish'), 'Orleans Parish')
  assert.equal(mod.countyDisplayLabel('Autauga'), 'Autauga County')
})

test('county authority rejects ZIP-derived partial nationwide lists', async () => {
  const mod = await import('../../backend/services/countyFundingCrawler.js')
  const partial = Array.from({ length: 3112 }, (_, i) => ({
    state: `S${i % 51}`,
    county: `County ${i}`,
  }))
  assert.equal(mod.countyAuthorityIsComplete(partial), false)

  const completeShape = []
  const stateCodes = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  ]
  for (let i = 0; i < 3140; i += 1) {
    completeShape.push({ state: stateCodes[i % stateCodes.length], county: `County ${i}` })
  }
  assert.equal(mod.countyAuthorityIsComplete(completeShape), true)
})