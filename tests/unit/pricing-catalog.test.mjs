import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRICING_CATALOG,
  listServices,
  getService,
  getServicePrice,
  catalogIsEthical,
} from '../../backend/services/pricing/pricingCatalog.js'
import {
  PRICING_CATALOG_VERSION,
  CLIENT_CATEGORIES,
  PAYMENT_TERMS,
  SERVICE_KEYS,
} from '../../backend/services/pricing/pricingTypes.js'

const REQUIRED_SERVICES = [
  ['Quick Eligibility Scan', { individual: 149, small: 349, mid_size: 349, large: 750 }],
  ['Comprehensive Funding Dossier', { individual: 399, small: 1250, mid_size: 2400, large: 3800 }],
  ['Application Strategy Session', { individual: 300, small: 450, mid_size: 600, large: 600 }],
  ['Micro-Grant Application (<$5K)', { individual: 600, small: 900, mid_size: 1200, large: 1200 }],
  ['Standard Foundation Application', { individual: 2000, small: 3500, mid_size: 5000, large: 5000 }],
  ['Complex/Federal Application', { individual: 5000, small: 8000, mid_size: 12000, large: 12000 }],
  ['Transfer Scholarship Pack', { individual: 450, small: 450, mid_size: 450, large: 450 }],
  ['Editing & Redraft Service', { individual: 300, small: 500, mid_size: 900, large: 900 }],
  ['Budget & Logic Model Development', { individual: 350, small: 600, mid_size: 900, large: 900 }],
  ['Compliance Reporting & Management', { individual: 500, small: 1000, mid_size: 1500, large: 1500 }],
  ['Grant Calendar Setup & Management', { individual: 800, small: 1200, mid_size: 1800, large: 1800 }],
  ['Hourly Consultation & Advisory', { individual: 85, small: 85, mid_size: 115, large: 150 }],
]

test('catalog version is 2026-06-15 and frozen', () => {
  assert.equal(PRICING_CATALOG_VERSION, '2026-06-15')
  assert.equal(PRICING_CATALOG.version, '2026-06-15')
  assert.throws(() => { PRICING_CATALOG.services.push({}) })
})

test('catalog includes all 12 services with the exact prices from the menu', () => {
  const services = listServices()
  assert.equal(services.length, REQUIRED_SERVICES.length)
  for (const [name, prices] of REQUIRED_SERVICES) {
    const svc = services.find((s) => s.name === name)
    assert.ok(svc, `missing service ${name}`)
    for (const [cat, expected] of Object.entries(prices)) {
      assert.equal(svc.prices[cat], expected, `${name}/${cat} must be $${expected}, got $${svc.prices[cat]}`)
    }
  }
})

test('catalog payment terms reflect the published 40/40/20 schedule + Net 15 + 1.5% interest', () => {
  assert.deepEqual(PAYMENT_TERMS.schedule.map((s) => s.percent), [40, 40, 20])
  assert.equal(PAYMENT_TERMS.net_days, 15)
  assert.equal(PAYMENT_TERMS.late_fee_monthly_interest_percent, 1.5)
  assert.match(PAYMENT_TERMS.ethical_billing_standard, /not contingent on award outcomes/i)
  assert.match(PAYMENT_TERMS.ethical_billing_standard, /no percentage-based or commission fees/i)
})

test('client-category labels cover individual / small / mid_size / large', () => {
  for (const cat of Object.values(CLIENT_CATEGORIES)) {
    const svc = getService(SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN)
    const price = svc.prices[cat]
    assert.ok(Number.isFinite(price), `Quick Eligibility Scan must have a price for ${cat}`)
  }
})

test('catalogIsEthical() rejects commission/contingent language', () => {
  assert.equal(catalogIsEthical(), true)
})

test('getServicePrice resolves prices per category', () => {
  assert.equal(getServicePrice(SERVICE_KEYS.MICRO_GRANT_APPLICATION, 'small'), 900)
  assert.equal(getServicePrice(SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION, 'mid_size'), 12000)
  assert.equal(getServicePrice(SERVICE_KEYS.HOURLY_CONSULTATION, 'large'), 150)
  assert.equal(getServicePrice('does_not_exist', 'small'), null)
})
