import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { seedServiceCatalogFromExtract } from '../../backend/services/serviceCatalogStore.js'
import { syncStripeServicePrices } from '../../backend/services/pricing/stripeServicePriceSync.js'

async function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  await seedServiceCatalogFromExtract(db)
  const products = [], prices = []
  const stripe = {
    products: {
      list: async () => ({ data: products, has_more: false }),
      create: async (args, options) => {
        assert.ok(options.idempotencyKey)
        const row = { id: `prod_${products.length + 1}`, active: true, ...args }
        products.push(row); return row
      },
    },
    prices: {
      list: async () => ({ data: prices, has_more: false }),
      create: async (args, options) => {
        assert.ok(options.idempotencyKey)
        const row = { id: `price_${prices.length + 1}`, active: true, type: 'one_time', recurring: null, ...args }
        prices.push(row); return row
      },
    },
  }
  return { db, stripe, products, prices }
}

test('dry run plans only 72 payable rows without writing Stripe or database mappings', async t => {
  const f = await fixture(t)
  const plan = await syncStripeServicePrices(f)
  assert.equal(plan.checked, 72)
  assert.equal(plan.create_prices, 72)
  assert.equal(plan.create_products, 12)
  assert.equal(f.products.length, 0)
  assert.equal(f.prices.length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM service_prices WHERE stripe_price_id IS NOT NULL').get().n, 0)
})

test('apply preserves approved amounts, milestone splits and six-minute units, then reruns without creating duplicates', async t => {
  const f = await fixture(t)
  const first = await syncStripeServicePrices({ ...f, apply: true })
  assert.equal(first.mapped, 72)
  assert.equal(f.prices.length, 72)
  assert.equal(f.products.length, 12)
  for (const price of f.prices) {
    assert.equal(price.type, 'one_time')
    assert.equal(price.metadata.app, 'grantflow')
    const row = f.db.prepare('SELECT amount_cents FROM service_prices WHERE stripe_price_id = ?').get(price.id)
    assert.equal(price.unit_amount, row.amount_cents)
  }
  const hourly = f.prices.find(p => p.metadata.service_slug === 'hourly-consultation-and-advisory' && p.metadata.client_category === 'individual')
  assert.equal(hourly.unit_amount, 850)
  assert.equal(hourly.metadata.unit, 'six_minutes')
  const second = await syncStripeServicePrices({ ...f, apply: true })
  assert.equal(second.mapped, 0)
  assert.equal(f.prices.length, 72)
  assert.equal(f.products.length, 12)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM service_prices WHERE milestone_phase = '' AND stripe_price_id IS NULL").get().n, 12)
})

test('catalog drift or missing installment blocks before any external writes', async t => {
  const f = await fixture(t)
  f.db.prepare("UPDATE service_prices SET amount_cents = amount_cents + 1 WHERE client_category = 'individual'").run()
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /CATALOG_DRIFT/)
  assert.equal(f.products.length, 0)
  assert.equal(f.prices.length, 0)
})

test('a missing price row fails closed instead of producing an incomplete green plan', async t => {
  const f = await fixture(t)
  f.db.prepare("DELETE FROM service_prices WHERE milestone_phase = 'submission' AND client_category = 'individual'").run()
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /INCOMPLETE_CATALOG/)
  assert.equal(f.products.length, 0)
})

test('reuses the Stripe price after a database write fails without creating or charging twice', async t => {
  const f = await fixture(t)
  f.db.exec("CREATE TRIGGER block_mapping BEFORE UPDATE OF stripe_price_id ON service_prices BEGIN SELECT RAISE(ABORT, 'mapping unavailable'); END;")
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /mapping unavailable/)
  assert.equal(f.prices.length, 1)
  f.db.exec('DROP TRIGGER block_mapping')
  const retried = await syncStripeServicePrices({ ...f, apply: true })
  assert.equal(retried.mapped, 72)
  assert.equal(f.prices.length, 72)
  assert.equal(f.products.length, 12)
})

test('a mapped Stripe price with drift blocks without overwriting the mapping', async t => {
  const f = await fixture(t)
  await syncStripeServicePrices({ ...f, apply: true })
  f.prices[0].unit_amount += 1
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /STRIPE_PRICE_MISMATCH/)
  assert.equal(f.prices.length, 72)
})

test('a concurrent catalog edit prevents the stale mapping from being written', async t => {
  const f = await fixture(t)
  const create = f.stripe.prices.create
  f.stripe.prices.create = async (...args) => {
    const price = await create(...args)
    f.db.prepare('UPDATE service_prices SET amount_cents = amount_cents + 1').run()
    return price
  }
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /CATALOG_CHANGED_DURING_SYNC/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM service_prices WHERE stripe_price_id IS NOT NULL').get().n, 0)
})

test('an unrelated Stripe product cannot be reused even when the amount matches', async t => {
  const f = await fixture(t)
  await syncStripeServicePrices({ ...f, apply: true })
  f.products[0].metadata.app = 'another-app'
  await assert.rejects(syncStripeServicePrices({ ...f, apply: true }), /STRIPE_PRICE_MISMATCH/)
  assert.equal(f.products.length, 12)
})
