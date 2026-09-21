import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applySubscription, applyPaymentFailure, markPaid } = vi.hoisted(() => ({
  applySubscription: vi.fn(), applyPaymentFailure: vi.fn(), markPaid: vi.fn(),
}))
vi.mock('../services/serviceCatalogStore.js', () => ({ ensureServiceCatalogSchema: vi.fn() }))
vi.mock('../services/billing/subscriptionSync.js', () => ({
  applyStripeSubscription: applySubscription, applyStripePaymentFailure: applyPaymentFailure,
}))
vi.mock('../services/pricing/pricingAccessGate.js', () => ({ markPaid }))
vi.mock('../services/pricing/profilePricingInitializer.js', () => ({ recordPaymentAccessEvent: vi.fn() }))

import router from '../routes/stripeWebhook.js'
import { ensureInvoiceSchema } from '../services/billing/invoiceService.js'

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
    applyPaymentFailure.mockReset()
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
      CREATE TABLE milestone_payments (purchase_id TEXT, phase TEXT, status TEXT,
        stripe_payment_intent_id TEXT, paid_at TEXT, updated_at TEXT);
      CREATE TABLE hourly_invoices (id TEXT PRIMARY KEY, status TEXT,
        stripe_payment_intent_id TEXT, paid_at TEXT, updated_at TEXT);
      INSERT INTO milestone_payments (purchase_id, phase, status) VALUES ('purchase', 'submission', 'pending');
      INSERT INTO hourly_invoices (id, status) VALUES ('hourly', 'pending');
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

  it('retries payment-failure events that arrive before their subscription account is linked', async () => {
    const failedPayment = { id: 'evt_failed_invoice', type: 'invoice.payment_failed', created: 1780000000,
      data: { object: { subscription: 'sub_test' } } }
    applyPaymentFailure.mockResolvedValueOnce({ ok: false, reason: 'unresolved_subscription' })
      .mockResolvedValue({ ok: true, changed: true })
    expect((await deliver(failedPayment)).status).toBe(500)
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    expect((await deliver(failedPayment)).status).toBe(200)
    expect((await deliver(failedPayment)).body.duplicate).toBe(true)
    expect(applyPaymentFailure).toHaveBeenCalledTimes(2)
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

  it.each(['service_purchase', 'milestone_payment', 'hourly_invoice'])('refuses a %s checkout whose quote belongs to another profile', async (kind) => {
    markPaid.mockResolvedValue({ ok: true })
    const checkout = { id: 'evt_wrong_quote', type: 'checkout.session.completed',
      data: { object: { id: 'cs_wrong_quote', payment_status: 'paid',
        metadata: { kind, purchase_id: 'purchase', quote_id: 'other-quote', milestone_phase: 'submission', hourly_invoice_id: 'hourly' } } } }
    expect((await deliver(checkout)).status).toBe(500)
    expect(markPaid).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
    expect(db.prepare('SELECT status FROM milestone_payments').get().status).toBe('pending')
    expect(db.prepare('SELECT status FROM hourly_invoices').get().status).toBe('pending')
  })

  it('rolls back recurring invoice settlement when restoring suspended access fails, then retries', async () => {
    db.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY, status TEXT); INSERT INTO profiles VALUES ('profile', 'suspended')")
    await ensureInvoiceSchema(db)
    db.exec("INSERT INTO billing_invoices (id, profile_id, cadence, period_key, status) VALUES ('invoice', 'profile', 'monthly', 'test-period', 'suspended')")
    db.exec("CREATE TRIGGER fail_reactivation BEFORE UPDATE OF status ON profiles BEGIN SELECT RAISE(ABORT, 'reactivation unavailable'); END")
    const checkout = { id: 'evt_recurring', type: 'checkout.session.completed',
      data: { object: { id: 'cs_recurring', payment_status: 'paid',
        metadata: { kind: 'recurring_invoice', billing_invoice_id: 'invoice', profile_id: 'profile' } } } }
    expect((await deliver(checkout)).status).toBe(500)
    expect(db.prepare('SELECT status FROM billing_invoices').get().status).toBe('suspended')
    expect(db.prepare('SELECT status FROM profiles').get().status).toBe('suspended')
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
    db.exec('DROP TRIGGER fail_reactivation')
    expect((await deliver(checkout)).status).toBe(200)
    expect(db.prepare('SELECT status FROM billing_invoices').get().status).toBe('paid')
    expect(db.prepare('SELECT status FROM profiles').get().status).toBe('active')
    expect((await deliver(checkout)).body.duplicate).toBe(true)
  })

  it('rejects quote linkage on a purchase without a profile', async () => {
    db.prepare('UPDATE service_purchases SET profile_id = NULL').run()
    const checkout = { id: 'evt_unlinked_quote', type: 'checkout.session.completed',
      data: { object: { id: 'cs_unlinked_quote', payment_status: 'paid',
        metadata: { kind: 'service_purchase', purchase_id: 'purchase', quote_id: 'other-quote' } } } }
    expect((await deliver(checkout)).status).toBe(500)
    expect(db.prepare('SELECT status FROM service_purchases').get().status).toBe('pending')
    expect(db.prepare('SELECT * FROM stripe_webhook_events').all()).toEqual([])
  })
})
