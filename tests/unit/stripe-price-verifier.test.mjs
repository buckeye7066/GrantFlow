/**
 * Stripe Price verifier unit tests — exercises the deterministic mock
 * path so CI can guarantee `service_prices` mappings match Stripe
 * without making real Stripe API calls.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.STRIPE_MOCK = 'true'

import { verifyStripePriceMapping, verifyStripePrice } from '../../backend/services/pricing/stripePriceVerifier.js'

function newDb({ stripeId = 'price_test', amountCents = 14900 } = {}) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE service_catalog_items (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      pricing_model TEXT NOT NULL, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE service_prices (
      id TEXT PRIMARY KEY, service_id TEXT NOT NULL, client_category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd',
      milestone_phase TEXT NOT NULL DEFAULT '', stripe_price_id TEXT,
      active INTEGER DEFAULT 1
    );
  `)
  db.prepare(
    `INSERT INTO service_catalog_items (id, slug, name, pricing_model)
     VALUES ('svc_qes', 'quick-eligibility-scan', 'Quick Eligibility Scan', 'one_time')`,
  ).run()
  db.prepare(
    `INSERT INTO service_prices (id, service_id, client_category, amount_cents, stripe_price_id)
     VALUES ('p1', 'svc_qes', 'individual', ?, ?)`,
  ).run(amountCents, stripeId)
  return db
}

test('verifier reports ok when Stripe mock matches DB amount', async () => {
  const db = newDb()
  const r = await verifyStripePriceMapping(db)
  assert.equal(r.ok, true)
  assert.equal(r.checked, 1)
  assert.equal(r.rows[0].status, 'ok')
})

test('verifier reports missing_mapping when stripe_price_id is null', async () => {
  const db = newDb({ stripeId: null })
  const r = await verifyStripePriceMapping(db)
  assert.equal(r.ok, false)
  assert.equal(r.missing_mapping_count, 1)
  assert.equal(r.rows[0].status, 'missing_mapping')
})

test('verifier reports amount_mismatch when override differs', async () => {
  const db = newDb()
  const overrides = new Map([['price_test', { amount_cents: 99999, currency: 'usd', active: true }]])
  const r = await verifyStripePriceMapping(db, { mockOverrides: overrides })
  assert.equal(r.ok, false)
  assert.equal(r.mismatch_count, 1)
  assert.equal(r.rows[0].status, 'amount_mismatch')
})

test('verifier reports inactive when Stripe price is disabled', async () => {
  const db = newDb()
  const overrides = new Map([['price_test', { amount_cents: 14900, currency: 'usd', active: false }]])
  const r = await verifyStripePriceMapping(db, { mockOverrides: overrides })
  assert.equal(r.ok, false)
  assert.equal(r.inactive_count, 1)
  assert.equal(r.rows[0].status, 'inactive')
})

test('verifier reports currency_mismatch when override has different currency', async () => {
  const db = newDb()
  const overrides = new Map([['price_test', { amount_cents: 14900, currency: 'eur', active: true }]])
  const r = await verifyStripePriceMapping(db, { mockOverrides: overrides })
  assert.equal(r.ok, false)
  assert.equal(r.mismatch_count, 1)
  assert.equal(r.rows[0].status, 'currency_mismatch')
})

test('verifyStripePrice single-id helper returns deterministic mock data', async () => {
  const r = await verifyStripePrice('price_anything')
  assert.ok(r)
  // The mock fetcher with no DB row context returns the requested ID.
  assert.equal(r.id, 'price_anything')
  assert.equal(r.active, true)
})

test('verifyStripePrice returns null for empty input', async () => {
  const r = await verifyStripePrice('')
  assert.equal(r, null)
})

test('milestone totals are reference prices, while every actual installment still requires a mapping', async () => {
  const db = newDb()
  db.prepare("UPDATE service_catalog_items SET pricing_model = 'milestone'").run()
  db.prepare("UPDATE service_prices SET stripe_price_id = NULL").run()
  db.prepare("INSERT INTO service_prices (id, service_id, client_category, amount_cents, milestone_phase) VALUES ('phase', 'svc_qes', 'individual', 5960, 'kickoff')").run()
  const r = await verifyStripePriceMapping(db)
  assert.equal(r.checked, 1)
  assert.equal(r.missing_mapping_count, 1)
  assert.equal(r.rows[0].milestone_phase, 'kickoff')
  db.close()
})

test('a provider read failure cannot produce a green verification report', async () => {
  const db = newDb()
  const r = await verifyStripePriceMapping(db, { mockOverrides: new Map([
    ['price_test', { amount_cents: 14900, currency: 'usd', active: true, error: 'Provider unavailable' }],
  ]) })
  assert.equal(r.rows[0].status, 'fetch_error')
  assert.equal(r.ok, false)
  db.close()
})

test('missing verifier credentials cannot produce a green report', async t => {
  const previousMock = process.env.STRIPE_MOCK
  const previousKey = process.env.STRIPE_SECRET_KEY
  t.after(() => {
    if (previousMock === undefined) delete process.env.STRIPE_MOCK
    else process.env.STRIPE_MOCK = previousMock
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = previousKey
  })
  process.env.STRIPE_MOCK = 'false'
  delete process.env.STRIPE_SECRET_KEY
  const db = newDb()
  const r = await verifyStripePriceMapping(db)
  assert.equal(r.rows[0].status, 'verifier_unavailable')
  assert.equal(r.ok, false)
  db.close()
})
