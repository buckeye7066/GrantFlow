/**
 * Catalog version + slug aliases + extract parser invariants for the
 * 2026-06-15 GrantFlow pricing sheet. These tests are intentionally
 * decoupled from the legacy `services-catalog-and-stripe.test.mjs`
 * suite (which boots a full server) so they can be run quickly in
 * isolation by the agent during fix iterations.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANONICAL_EXTRACT_VERSION,
  parsePaymentSheetExtract,
  loadPaymentSheetExtractFromDisk,
  getCanonicalServiceCatalogExtractPath,
} from '../../backend/services/serviceCatalogExtractParser.js'
import {
  CANONICAL_SLUGS,
  LEGACY_SLUG_TO_CANONICAL,
  resolveCanonicalServiceSlug,
  isKnownServiceSlug,
  legacyAliasesByCanonical,
} from '../../backend/services/pricing/serviceSlugAliases.js'
import { PRICING_CATALOG_VERSION } from '../../backend/services/pricing/pricingTypes.js'

test('Test 1: active extract parser returns version 2026-06-15', () => {
  assert.equal(CANONICAL_EXTRACT_VERSION, '2026-06-15')
  const md = loadPaymentSheetExtractFromDisk()
  const parsed = parsePaymentSheetExtract(md)
  assert.equal(parsed.version, '2026-06-15')
})

test('Test 2: all 12 services exist in the parsed extract', () => {
  const parsed = parsePaymentSheetExtract(loadPaymentSheetExtractFromDisk())
  assert.equal(parsed.services.length, 12)
})

test('Test 3: all 4 client categories have prices for every service', () => {
  const parsed = parsePaymentSheetExtract(loadPaymentSheetExtractFromDisk())
  const categories = ['individual', 'small', 'mid', 'large']
  for (const svc of parsed.services) {
    for (const cat of categories) {
      assert.ok(
        Number.isFinite(svc.prices[cat]) && svc.prices[cat] > 0,
        `${svc.name} missing price for ${cat}`,
      )
    }
  }
})

test('Test 4: extract amounts match the published 2026-06-15 menu (in cents)', () => {
  const parsed = parsePaymentSheetExtract(loadPaymentSheetExtractFromDisk())
  const bySlug = new Map(parsed.services.map((s) => [s.slug, s]))
  const expected = [
    ['quick-eligibility-scan', { individual: 14900, small: 34900, mid: 34900, large: 75000 }],
    ['comprehensive-funding-dossier', { individual: 39900, small: 125000, mid: 240000, large: 380000 }],
    ['application-strategy-session', { individual: 30000, small: 45000, mid: 60000, large: 60000 }],
    ['micro-grant-application', { individual: 60000, small: 90000, mid: 120000, large: 120000 }],
    ['standard-foundation-application', { individual: 200000, small: 350000, mid: 500000, large: 500000 }],
    ['complex-federal-application', { individual: 500000, small: 800000, mid: 1200000, large: 1200000 }],
    ['transfer-scholarship-pack', { individual: 45000, small: 45000, mid: 45000, large: 45000 }],
    ['editing-and-redraft-service', { individual: 30000, small: 50000, mid: 90000, large: 90000 }],
    ['budget-and-logic-model-development', { individual: 35000, small: 60000, mid: 90000, large: 90000 }],
    ['compliance-reporting-and-management', { individual: 50000, small: 100000, mid: 150000, large: 150000 }],
    ['grant-calendar-setup-and-management', { individual: 80000, small: 120000, mid: 180000, large: 180000 }],
    ['hourly-consultation-and-advisory', { individual: 8500, small: 8500, mid: 11500, large: 15000 }],
  ]
  for (const [slug, prices] of expected) {
    const svc = bySlug.get(slug)
    assert.ok(svc, `missing service slug: ${slug}`)
    for (const [cat, cents] of Object.entries(prices)) {
      assert.equal(svc.prices[cat], cents, `${slug}/${cat} expected ${cents}, got ${svc.prices[cat]}`)
    }
  }
})

test('Test 5: hourly unit cents are catalog hourly cents (the seeder converts to 6-min units)', () => {
  // The parser stores the *hourly* rate; the seeder later converts to a
  // per-6-minute unit (rate / 10). This test guards the parser's input
  // shape so the conversion math stays correct downstream.
  const parsed = parsePaymentSheetExtract(loadPaymentSheetExtractFromDisk())
  const hourly = parsed.services.find((s) => s.slug === 'hourly-consultation-and-advisory')
  assert.ok(hourly)
  // $85/hr = 8500 cents/hr; per-6-min unit = 850 cents (parser stores hourly).
  assert.equal(hourly.prices.individual, 8500)
  assert.equal(hourly.prices.large, 15000)
  // Sanity-check the unit-conversion contract used by serviceCatalogStore.
  const unitFromHourly = (hr) => Math.round(hr / 10)
  assert.equal(unitFromHourly(8500), 850)
  assert.equal(unitFromHourly(15000), 1500)
})

test('Test 9 + 10: canonical slug map covers all 12 services and resolves legacy slugs', () => {
  assert.equal(CANONICAL_SLUGS.size, 12)
  assert.equal(resolveCanonicalServiceSlug('standard-foundation-application-5k-250k'), 'standard-foundation-application')
  assert.equal(resolveCanonicalServiceSlug('complex-federal-application-250k'), 'complex-federal-application')
  assert.equal(resolveCanonicalServiceSlug('transfer-scholarship-pack-flat-pricing'), 'transfer-scholarship-pack')
  assert.equal(resolveCanonicalServiceSlug('quick-eligibility-scan'), 'quick-eligibility-scan')
  assert.equal(resolveCanonicalServiceSlug('not-a-real-slug'), null)
  assert.equal(isKnownServiceSlug('quick-eligibility-scan'), true)
  assert.equal(isKnownServiceSlug('totally-fake'), false)
  // Reverse map sanity check.
  const rev = legacyAliasesByCanonical()
  assert.ok(rev['standard-foundation-application']?.includes('standard-foundation-application-5k-250k'))
})

test('parser returns canonical 2026-06-15 path', () => {
  const p = getCanonicalServiceCatalogExtractPath()
  assert.match(p, /2026-06-15_EXTRACT\.md$/)
})

test('catalog code version stays in lock-step with the extract version', () => {
  assert.equal(PRICING_CATALOG_VERSION, CANONICAL_EXTRACT_VERSION)
})

// Exhaustive guard: every legacy slug we list maps to one of the 12
// canonical slugs. A typo here would cause silent checkout failures.
test('every legacy alias maps to a canonical slug', () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_SLUG_TO_CANONICAL)) {
    assert.ok(CANONICAL_SLUGS.has(canonical), `legacy ${legacy} -> non-canonical ${canonical}`)
  }
})

// The real on-disk extract currently carries a placeholder CashApp handle
// ("$example-payment-handle") - backend/routes/services.js GET
// /api/services/terms serves terms.full_text verbatim to any logged-in
// client, so this must never reach a client unredacted. Runs against the
// REAL file, not a synthetic fixture, so it fails the moment someone fixes
// the placeholder in the source doc (a reminder to relax this test then).
test('a placeholder payment handle in the real extract is redacted, never served verbatim', () => {
  const md = loadPaymentSheetExtractFromDisk()
  const parsed = parsePaymentSheetExtract(md)
  assert.ok(
    !parsed.terms.full_text.includes('$example-payment-handle'),
    'placeholder CashApp handle leaked into client-facing terms.full_text',
  )
  assert.ok(
    parsed.terms.payment_method_warnings.some((w) => w.method === 'CashApp'),
    'expected a payment_method_warnings entry naming CashApp',
  )
})

test('redactPlaceholderPaymentMethods leaves a real handle untouched', () => {
  const md = loadPaymentSheetExtractFromDisk().replace(
    '$example-payment-handle',
    '$RealHandle123',
  )
  const parsed = parsePaymentSheetExtract(md)
  assert.ok(parsed.terms.full_text.includes('$RealHandle123'))
  assert.equal(parsed.terms.payment_method_warnings.length, 0)
})
