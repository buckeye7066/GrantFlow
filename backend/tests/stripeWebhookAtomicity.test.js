import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applySubscription, markPaid } = vi.hoisted(() => ({
  applySubscription: vi.fn(), markPaid: vi.fn(),
}))
vi.mock('../services/serviceCatalogStore.js', () => ({ ensureServiceCatalogSchema: vi.fn() }))
vi.mock('../services/billing/subscriptionSync.js', () => ({
  applyStripeSubscription: applySubscription, applyStripePaymentFailure: vi.fn(),
}))
vi.mock('../services/pricing/pricingAccessGate.js', () => ({ markPaid }))
vi.mock('../services/pricing/profilePricingInitializer.js', () => ({ recordPaymentAccessEvent: vi.fn() }))

import router from '../routes/stripeWebhook.js'

describe('Stripe webhook atomic delivery', () => {
  let db
  let app
  const stripe = new Stripe('sk_test_local_fixture', { telemetry: false })
  const secret = 'whsec_local_atomicity_fixture'
  const event = {
    id: 'evt_retry', type: 'customer.subscription.updated', created: 1780000000,
    data: { object: { id: 'sub_test', status: 'active' } },
  }

  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_local_fixture')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret)
    applySubscription.mockReset()
    markPaid.mockReset()
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    db.exec(`
      CREATE TABLE stripe_webhook_events (event_id TEXT PRIMARY KEY, type TEXT);
      CREATE TABLE effects (id TEXT PRIMARY KEY);
      CREATE TABLE service_purchases (
        id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT, status TEXT,
        stripe_payment_intent_id TEXT, stripe_checkout_session_id TEXT, updated_at TEXT
      );
      CREATE TABLE pricing_quotes (id TEXT PRIMARY KEY, profile_id TEXT);
      INSERT INTO pricing_quotes (id, profile_id) VALUES ('other-quote', 'another-profile');
      INSERT INTO service_purchases (id, profile_id, user_id, status)
      VALUES ('purchase', 'profile', 'user', 'pending');
    `)
    let tail = Promise.resolve()
    db.withTransaction = (work) => {
      const next = tail.then(async () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = await work(db)
          db.exec('COMMIT')
          return result
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
      tail = next.catch(() => {})
      return next
    }
    applySubscription.mockImplementation(async (tx) => {
      tx.prepare('INSERT INTO effects (id) VALUES (?)').run('applied')
      return { ok: true }
    })
    app = express()
    app.use((req, _res, next) => { req.db = db; next() })
    app.use('/webhook', express.raw({ type: 'application/json' }), router)
  })

  afterEach(() => { db.close(); vi.unstubAllEnvs() })

  function deliver(payload = event, signatureOverride) {
    const body = JSON.stringify(payload)
    const signature = signatureOverride ?? stripe.webhooks.generateTestHeaderString({ payload: body, secret })
    return request(app).post('/webhook').set('Content-Type', 'application/json')
      .set('stripe-signature', signature).send(body)
  }

  it('rolls back failed fulfillment and lets the same signed event retry successfully', async () => {
    applySubscription.mockImplementationOnce(async (tx) => {
      tx.prepare('INSERT INTO effects (id) VALUES (?)').run('partial')
      throw new Error('simulated storage outage')
    })
    expect((await deliver()).status).toBe(500)
    expect(db.prepare('SELECT * FROM effects').all()).toEqual([])
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    expect((await deliver()).status).toBe(200)
    expect(db.prepare('SELECT * FROM effects').all()).toEqual([{ id: 'applied' }])
    expect((await deliver()).body.duplicate).toBe(true)
    expect(applySubscription).toHaveBeenCalledTimes(2)
  })

  it('fulfills concurrent duplicate deliveries once', async () => {
    const responses = await Promise.all([deliver(), deliver()])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect(responses.filter((r) => r.body.duplicate)).toHaveLength(1)
    expect(applySubscription).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ok: false, reason: 'no_billing_account' },
    { ok: true, reason: 'unmapped_price_id' },
  ])('keeps unresolved subscription fulfillment retryable: $reason', async (result) => {
    applySubscription.mockResolvedValueOnce(result)
    expect((await deliver()).status).toBe(500)
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    expect((await deliver()).status).toBe(200)
    expect(db.prepare('SELECT * FROM effects').all()).toEqual([{ id: 'applied' }])
  })

  it('rejects an invalid signature before recording an event or granting access', async () => {
    expect((await deliver(event, 'invalid')).status).toBe(400)
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    expect(applySubscription).not.toHaveBeenCalled()
  })

  it('retries a paid checkout if granting profile access fails', async () => {
    const checkout = {
      id: 'evt_checkout', type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', payment_status: 'paid', payment_intent: 'pi_test',
        metadata: { kind: 'service_purchase', purchase_id: 'purchase' } } },
    }
    markPaid.mockRejectedValueOnce(new Error('profile write failed')).mockResolvedValue({ ok: true })
    expect((await deliver(checkout)).status).toBe(500)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    expect((await deliver(checkout)).status).toBe(200)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('paid')
    expect(markPaid).toHaveBeenCalledTimes(2)
  })

  it('waits for delayed payment success before fulfilling a completed checkout', async () => {
    markPaid.mockResolvedValue({ ok: true })
    const checkout = {
      id: 'evt_unpaid', type: 'checkout.session.completed',
      data: { object: { id: 'cs_delayed', payment_status: 'unpaid',
        metadata: { kind: 'service_purchase', purchase_id: 'purchase' } } },
    }
    expect((await deliver(checkout)).status).toBe(200)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
    expect(markPaid).not.toHaveBeenCalled()
    const settled = { ...checkout, id: 'evt_settled', type: 'checkout.session.async_payment_succeeded',
      data: { object: { ...checkout.data.object, payment_status: 'paid' } } }
    expect((await deliver(settled)).status).toBe(200)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('paid')
    expect(markPaid).toHaveBeenCalledTimes(1)
  })

  it('does not grant access when the access writer returns an unsuccessful result', async () => {
    markPaid.mockResolvedValue({ ok: false, error: 'pricing_tables_not_installed' })
    const checkout = { id: 'evt_no_access', type: 'checkout.session.completed',
      data: { object: { id: 'cs_no_access', payment_status: 'paid',
        metadata: { kind: 'service_purchase', purchase_id: 'purchase' } } } }
    expect((await deliver(checkout)).status).toBe(500)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
  })

  it('refuses a checkout whose quote belongs to another profile', async () => {
    markPaid.mockResolvedValue({ ok: true })
    const checkout = { id: 'evt_wrong_quote', type: 'checkout.session.completed',
      data: { object: { id: 'cs_wrong_quote', payment_status: 'paid',
        metadata: { kind: 'service_purchase', purchase_id: 'purchase', quote_id: 'other-quote' } } } }
    expect((await deliver(checkout)).status).toBe(500)
    expect(markPaid).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
  })
})
