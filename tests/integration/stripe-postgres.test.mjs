// Explicit local integration lane: GRANTFLOW_STRIPE_TEST_DATABASE_URL must name
// a disposable localhost PostgreSQL database. Each run owns a separate schema.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { applyStripeSubscription, applyStripePaymentFailure } from '../../backend/services/billing/subscriptionSync.js'
import { recordStripeEventIfNew } from '../../backend/services/stripeService.js'
import { syncStripeServicePrices } from '../../backend/services/pricing/stripeServicePriceSync.js'

test('PostgreSQL billing delivery is atomic and serializes account transitions', async (t) => {
  const raw = process.env.GRANTFLOW_STRIPE_TEST_DATABASE_URL
  assert.ok(raw, 'Set GRANTFLOW_STRIPE_TEST_DATABASE_URL to a disposable localhost PostgreSQL database')
  const url = new URL(raw)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This test only permits a local database')
  const schema = `grantflow_stripe_${randomUUID().replaceAll('-', '')}`
  const control = new pg.Pool({ connectionString: raw })
  let db
  try {
    await control.query(`CREATE SCHEMA ${schema}`)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    process.env.NODE_ENV = 'test'
    process.env.DB_PROVIDER = 'postgres'
    process.env.DATABASE_URL = url.href
    process.env.STRIPE_PRICE_GROWTH = 'price_test_growth'
    db = (await import('../../backend/db/index.js')).getDb()
    await db.exec(`
      CREATE TABLE stripe_webhook_events (event_id TEXT PRIMARY KEY, type TEXT);
      CREATE TABLE effects (id TEXT PRIMARY KEY);
      CREATE TABLE billing_accounts (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, tier_id TEXT,
        assigned_by TEXT, assigned_reason TEXT, discount_type TEXT, discount_percent REAL DEFAULT 0,
        is_pro_bono BOOLEAN DEFAULT FALSE,
        stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_price_id TEXT,
        subscription_status TEXT, subscription_current_period_end TIMESTAMPTZ,
        stripe_event_created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE billing_account_events (
        id TEXT PRIMARY KEY, account_id TEXT, changed_by TEXT,
        previous_tier_id TEXT, new_tier_id TEXT,
        previous_discount_type TEXT, new_discount_type TEXT,
        previous_discount_percent REAL, new_discount_percent REAL,
        previous_pro_bono BOOLEAN, new_pro_bono BOOLEAN, notes TEXT
      );
      INSERT INTO billing_accounts (id, profile_id, tier_id) VALUES ('account', 'profile', 'foundation');
    `)
    const sub = (status) => ({
      id: 'sub_test', customer: 'cus_test', status, metadata: { profile_id: 'profile' },
      items: { data: [{ price: { id: 'price_test_growth' } }] },
    })

    await t.test('failure rolls back the event receipt and all writes; concurrent duplicate retries apply once', async () => {
      const event = { id: 'evt_atomic', type: 'test' }
      await assert.rejects(db.withTransaction(async (tx) => {
        assert.equal((await recordStripeEventIfNew(tx, event)).inserted, true)
        await tx.prepare('INSERT INTO effects (id) VALUES (?)').run('partial')
        throw new Error('test failure')
      }), /test failure/)
      assert.deepEqual(await db.prepare('SELECT * FROM effects').all(), [])
      assert.deepEqual(await db.prepare('SELECT * FROM stripe_webhook_events').all(), [])
      const deliver = () => db.withTransaction(async (tx) => {
        const result = await recordStripeEventIfNew(tx, event)
        if (result.inserted) await tx.prepare('INSERT INTO effects (id) VALUES (?)').run('once')
        return result
      })
      const results = await Promise.all([deliver(), deliver()])
      assert.equal(results.filter((r) => r.inserted).length, 1)
      assert.deepEqual(await db.prepare('SELECT * FROM effects').all(), [{ id: 'once' }])
    })

    async function overlappingEvents(older) {
      await db.withTransaction((tx) => applyStripeSubscription(tx, sub('active'), { eventCreated: 100 }))
      let releaseNewer
      let newerWritten
      const hold = new Promise((resolve) => { releaseNewer = resolve })
      const ready = new Promise((resolve) => { newerWritten = resolve })
      const newer = db.withTransaction(async (tx) => {
        await applyStripeSubscription(tx, sub('canceled'), { eventCreated: 300 })
        newerWritten()
        await hold
      })
      let delayed
      try {
        await Promise.race([ready, newer.then(() => { throw new Error('newer transaction ended before barrier') })])
        delayed = db.withTransaction(older)
        // Verify the competing transaction actually reached a database lock,
        // so this tests overlapping delivery rather than merely Promise order.
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const waiting = await control.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%billing_accounts%'",
          )
          if (waiting.rowCount) { blocked = true; break }
          await delay(20)
        }
        assert.equal(blocked, true, 'competing billing event must overlap the held transaction')
      } finally {
        releaseNewer()
        await newer
      }
      const result = await delayed
      assert.equal(result.reason, 'stale_event_ignored')
      const account = await db.prepare('SELECT tier_id, subscription_status FROM billing_accounts WHERE id = ?').get('account')
      assert.deepEqual(account, { tier_id: 'foundation', subscription_status: 'canceled' })
    }

    await t.test('an older recovery cannot undo a cancellation committed while it waits', async () => {
      await overlappingEvents((tx) => applyStripeSubscription(tx, sub('active'), { eventCreated: 200 }))
    })
    await t.test('an older invoice failure cannot overwrite a cancellation committed while it waits', async () => {
      await db.prepare('UPDATE billing_accounts SET stripe_event_created_at = NULL').run()
      await overlappingEvents((tx) => applyStripePaymentFailure(tx, { subscriptionId: 'sub_test', eventCreated: 200 }))
    })
    await t.test('service price configuration maps PostgreSQL boolean catalog rows and retries without duplicates', async () => {
      await db.exec(`
        CREATE TABLE service_catalog_items (id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT, pricing_model TEXT, is_active BOOLEAN);
        CREATE TABLE service_prices (id TEXT PRIMARY KEY, service_id TEXT, client_category TEXT, amount_cents INTEGER, currency TEXT,
          milestone_phase TEXT DEFAULT '', stripe_price_id TEXT, active BOOLEAN, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO service_catalog_items VALUES ('qes', 'quick-eligibility-scan', 'Quick Eligibility Scan', '', 'one_time', TRUE);
      `)
      for (const [category, amount] of [['individual', 14900], ['small', 34900], ['mid', 34900], ['large', 75000]]) {
        await db.prepare("INSERT INTO service_prices (id, service_id, client_category, amount_cents, currency, active) VALUES (?, 'qes', ?, ?, 'usd', TRUE)").run(category, category, amount)
      }
      const products = [], prices = []
      const stripe = {
        products: { list: async () => ({ data: products, has_more: false }), create: async args => {
          const product = { id: 'prod_qes', active: true, ...args }; products.push(product); return product
        } },
        prices: { list: async () => ({ data: prices, has_more: false }), create: async args => {
          const price = { id: `price_${prices.length}`, active: true, type: 'one_time', recurring: null, ...args }; prices.push(price); return price
        } },
      }
      assert.equal((await syncStripeServicePrices({ db, stripe })).create_prices, 4)
      assert.equal((await syncStripeServicePrices({ db, stripe, apply: true })).mapped, 4)
      assert.equal((await syncStripeServicePrices({ db, stripe, apply: true })).mapped, 0)
      assert.equal(prices.length, 4)
    })

    await t.test('a swallowed billing audit failure cannot acknowledge a rolled-back payment', async () => {
      await assert.rejects(db.withTransaction(async (tx) => {
        await recordStripeEventIfNew(tx, { id: 'evt_audit_failure', type: 'customer.subscription.updated' })
        await tx.exec('ALTER TABLE billing_account_events RENAME TO unavailable_account_events')
        return applyStripeSubscription(tx, sub('active'), { eventCreated: 400 })
      }), /transaction.*rolled back/i)
      assert.equal(await db.prepare('SELECT event_id FROM stripe_webhook_events WHERE event_id = ?').get('evt_audit_failure'), undefined)
      const account = await db.prepare('SELECT tier_id, subscription_status FROM billing_accounts WHERE id = ?').get('account')
      assert.deepEqual(account, { tier_id: 'foundation', subscription_status: 'canceled' })
    })
  } finally {
    if (db) await db.close()
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await control.end()
  }
})
