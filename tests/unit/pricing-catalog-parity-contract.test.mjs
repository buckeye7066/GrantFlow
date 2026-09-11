import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Production 2026-09-11 (/Pricing, as admin): the page rendered the canonical
// TierMatrix from GET /api/billing/catalog (Growth $99, Small org $149, Mid
// $349, Large $599) and, below it, hardcoded "illustrative" cards priced
// "$100 - $250 per month", "$250 - $500", "$25 - $75 per semester", plus a
// discount list promising "Up to 30% off" for students while the catalog grants
// 15%. Three cards linked "Get Started" to /CreateProfile, which is not a route.
// Prices, discounts and link targets on this page must come from the catalog
// and the router, never from literals.
const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('Pricing carries no hardcoded prices, discount percentages, or dead profile links', () => {
  const src = read('src/pages/Pricing.jsx')
  const priceLiterals = [...src.matchAll(/['"`]\$\d[\d,]*(?:\s*-\s*\$\d[\d,]*)?['"`]/g)].map((m) => m[0])
  assert.deepEqual(priceLiterals, [], `hardcoded price literals: ${priceLiterals.join(', ')}`)
  assert.doesNotMatch(src, /\bprice:\s*['"`]/, 'illustrative cards still declare a hardcoded price')
  assert.doesNotMatch(src, /\d+%\s*off/i, 'discount copy hardcodes a percentage instead of reading catalog.discounts')
  assert.doesNotMatch(src, /['"]CreateProfile['"]/, 'links to CreateProfile, which is not a route')
})
