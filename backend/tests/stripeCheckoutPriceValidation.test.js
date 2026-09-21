import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'

const sdk = vi.hoisted(() => ({ retrieve: vi.fn(), create: vi.fn() }))
vi.mock('stripe', () => ({ default: class Stripe {
  prices = { retrieve: sdk.retrieve }
  checkout = { sessions: { create: sdk.create } }
} }))
vi.mock('../middleware/auth.js', () => ({ ensureAuth: (_req, _res, next) => next(), ensureAdmin: (_req, _res, next) => next() }))
import { createCheckoutSessionForPrice } from '../services/stripeService.js'
import router from '../routes/stripe.js'
import { seedServiceCatalogFromExtract } from '../services/serviceCatalogStore.js'

const metadata = { service_slug: 'quick-eligibility-scan', client_category: 'individual', milestone_phase: '' }
const options = { priceId: 'price_approved', quantity: 1, expectedUnitAmountCents: 14900,
  expectedCurrency: 'usd', metadata, successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' }
function approvedPrice() {
  return { id: 'price_approved', active: true, unit_amount: 14900, currency: 'usd', type: 'one_time',
    billing_scheme: 'per_unit', recurring: null, transform_quantity: null,
    metadata: { app: 'grantflow', ...metadata },
    product: { active: true, metadata: { app: 'grantflow', service_slug: metadata.service_slug } } }
}
beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture')
  vi.stubEnv('STRIPE_MOCK', 'false')
  sdk.retrieve.mockReset().mockResolvedValue(approvedPrice())
  sdk.create.mockReset().mockResolvedValue({ id: 'cs_fixture', url: 'https://example.test/checkout' })
})

describe('service and hourly routes enforce the actual provider price', () => {
  let db, app
  beforeEach(async () => {
    db = new Database(':memory:')
    await seedServiceCatalogFromExtract(db)
    db.prepare("INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ('owner', 'cus_fixture')").run()
    app = express()
    app.use(express.json(), (req, _res, next) => { req.db = db; req.ctx = { userId: 'owner' }; next() })
    app.use(router)
  })
  afterEach(() => db.close())
  function purchase(model) {
    const service = db.prepare('SELECT * FROM service_catalog_items WHERE pricing_model = ? LIMIT 1').get(model)
    const price = db.prepare("SELECT * FROM service_prices WHERE service_id = ? AND client_category = 'individual' AND COALESCE(milestone_phase, '') = ''").get(service.id)
    db.prepare("UPDATE service_prices SET stripe_price_id = 'price_approved' WHERE id = ?").run(price.id)
    db.prepare("INSERT INTO service_purchases (id,user_id,service_id,client_category,pricing_model,status) VALUES ('purchase','owner',?,'individual',?,'pending')").run(service.id, model)
    if (model === 'hourly') db.prepare("INSERT INTO hourly_time_entries (id,purchase_id,minutes,rounded_minutes) VALUES ('time','purchase',15,18)").run()
    const meta = { app: 'grantflow', service_slug: service.slug, client_category: 'individual', milestone_phase: '' }
    sdk.retrieve.mockResolvedValue({ ...approvedPrice(), unit_amount: price.amount_cents, metadata: meta,
      product: { active: true, metadata: meta } })
    return price
  }
  for (const model of ['one_time', 'hourly']) {
    const endpoint = model === 'hourly' ? '/checkout/hourly' : '/checkout/service'
    it.each(['amount', 'currency', 'unavailable'])(`${model}: %s failure creates no checkout and allows retry`, async failure => {
      purchase(model)
      if (failure === 'unavailable') sdk.retrieve.mockRejectedValueOnce(new Error('provider unavailable'))
      else sdk.retrieve.mockResolvedValueOnce({ ...approvedPrice(), ...(failure === 'amount' ? { unit_amount: 75000 } : { currency: 'eur' }) })
      const response = await request(app).post(endpoint).send({ purchase_id: 'purchase', agree: true })
      expect(response.status).toBe(failure === 'unavailable' ? 503 : 409)
      expect(sdk.create).not.toHaveBeenCalled()
      if (model === 'hourly') expect(db.prepare("SELECT COUNT(*) AS n FROM hourly_invoices WHERE status = 'pending'").get().n).toBe(0)
      const retry = await request(app).post(endpoint).send({ purchase_id: 'purchase', agree: true })
      expect(retry.status).toBe(200)
      expect(sdk.create).toHaveBeenCalledTimes(1)
      expect(sdk.create.mock.calls[0][0].line_items).toEqual([{ price: 'price_approved', quantity: model === 'hourly' ? 3 : 1 }])
    })
  }
  it('hourly catalog drift is rejected before any Stripe call', async () => {
    const price = purchase('hourly')
    db.prepare('UPDATE service_prices SET amount_cents = 99999 WHERE id = ?').run(price.id)
    const response = await request(app).post('/checkout/hourly').send({ purchase_id: 'purchase', agree: true })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('DB_PRICE_CATALOG_DRIFT')
    expect(sdk.retrieve).not.toHaveBeenCalled()
    expect(sdk.create).not.toHaveBeenCalled()
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('payment checkout validates the actual Stripe price before creating a session', () => {
  it.each([
    ['amount', { unit_amount: 75000 }], ['currency', { currency: 'eur' }],
    ['inactive', { active: false }], ['recurring', { type: 'recurring', recurring: { interval: 'month' } }],
    ['tiered', { billing_scheme: 'tiered' }], ['quantity transform', { transform_quantity: { divide_by: 10, round: 'up' } }],
    ['other app', { metadata: { ...metadata, app: 'another_app' } }],
    ['other category', { metadata: { app: 'grantflow', ...metadata, client_category: 'large' } }],
    ['other phase', { metadata: { app: 'grantflow', ...metadata, milestone_phase: 'submission' } }],
    ['inactive product', { product: { active: false, metadata: { app: 'grantflow', service_slug: metadata.service_slug } } }],
    ['other service product', { product: { active: true, metadata: { app: 'grantflow', service_slug: 'another_service' } } }],
  ])('blocks %s mismatch without creating a checkout', async (_name, patch) => {
    sdk.retrieve.mockResolvedValue({ ...approvedPrice(), ...patch })
    await expect(createCheckoutSessionForPrice(options)).rejects.toMatchObject({ code: 'STRIPE_PRICE_MISMATCH' })
    expect(sdk.create).not.toHaveBeenCalled()
  })
  it('blocks unavailable verification', async () => {
    sdk.retrieve.mockRejectedValue(new Error('provider unavailable'))
    await expect(createCheckoutSessionForPrice(options)).rejects.toMatchObject({ code: 'STRIPE_PRICE_UNVERIFIED' })
    expect(sdk.create).not.toHaveBeenCalled()
  })
  it('requires a server-derived expected amount', async () => {
    await expect(createCheckoutSessionForPrice({ ...options, expectedUnitAmountCents: undefined }))
      .rejects.toMatchObject({ code: 'STRIPE_PRICE_EXPECTATION_REQUIRED' })
    expect(sdk.create).not.toHaveBeenCalled()
  })
  it('creates a checkout only for the verified price, preserving hourly unit quantity', async () => {
    sdk.retrieve.mockResolvedValue({ ...approvedPrice(), unit_amount: 850 })
    await createCheckoutSessionForPrice({ ...options, quantity: 3, expectedUnitAmountCents: 850 })
    expect(sdk.retrieve).toHaveBeenCalledWith('price_approved', { expand: ['product'] })
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment', line_items: [{ price: 'price_approved', quantity: 3 }],
    }), undefined)
  })
})
