/**
 * Billing routes — HTTP regression for the tier/entitlement surface.
 *
 * Proves: the tier catalog is public; the non-admin read path requires auth; the
 * admin-only routes reject non-admins (so a normal user can NEVER edit billing
 * tiers / discounts / pro-bono); and the read paths return tier + effective
 * billing. (The non-admin *success* read is covered at the unit level by
 * billingEffective.test.js + the route's getAccessibleProfileIds check, since a
 * real non-admin session needs a signed JWT this harness doesn't mint.)
 */
import request from 'supertest'
import express from 'express'
import billingRouter from '../routes/billing.js'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

describe('Billing routes', () => {
  let app
  let db
  const profileId = 'billtest-profile-1'

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    try {
      db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, 'Bill Test', 'organization', 'active')").run(profileId)
    } catch { /* schema variance */ }
  })

  it('GET /api/billing/catalog is PUBLIC and returns the canonical tiers', async () => {
    const res = await request(app).get('/api/billing/catalog')
    expect(res.status).toBe(200)
    const ids = (res.body.tiers || []).map((t) => t.id)
    expect(ids).toContain('small_org')
    expect(ids).toContain('mid_size')
    expect(ids).toContain('large_org')
    // Plain-English capability labels ship too (no raw flag names in the UI).
    expect(res.body.capability_labels?.enable_document_ai?.label).toBeTruthy()
  })

  it('GET /api/billing/me/:id requires authentication', async () => {
    const res = await request(app).get(`/api/billing/me/${profileId}`)
    expect(res.status).toBe(401)
  })

  it('an admin can read the effective (seat-driven) billing via /me', async () => {
    const res = await request(app).get(`/api/billing/me/${profileId}`).set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    expect(res.body.read_only).toBe(true)
    expect(res.body.account?.tier?.id).toBeTruthy()
    expect(typeof res.body.billing?.net_monthly_cents).toBe('number')
  })

  it('the admin-only account READ rejects an unauthenticated/non-admin caller', async () => {
    const res = await request(app).get(`/api/billing/accounts/${profileId}`)
    expect([401, 403]).toContain(res.status)
  })

  it('a non-admin CANNOT edit billing (PUT /accounts/:id is admin-only)', async () => {
    const res = await request(app)
      .put(`/api/billing/accounts/${profileId}`)
      .send({ tier_id: 'enterprise', is_pro_bono: true })
    expect([401, 403]).toContain(res.status)
  })

  it('an admin CAN edit billing (control case)', async () => {
    const res = await request(app)
      .put(`/api/billing/accounts/${profileId}`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ tier_id: 'mid_size' })
    expect(res.status).toBe(200)
  })

  it('records a customer plan request without granting the requested tier, then resolves it on admin approval', async () => {
    await request(app).get(`/api/billing/me/${profileId}`).set(TEST_ADMIN_AUTH_HEADER)
    const previous = db.prepare('SELECT tier_id FROM billing_accounts WHERE profile_id = ?').get(profileId).tier_id
    const response = await request(app).post(`/api/billing/me/${profileId}/plan-request`).set(TEST_ADMIN_AUTH_HEADER).send({ tier_id: 'growth' })
    expect(response.status).toBe(200)
    expect(response.body.plan_request).toMatchObject({ tier_id: 'growth', status: 'pending_review' })
    const pending = db.prepare('SELECT tier_id, metadata FROM billing_accounts WHERE profile_id = ?').get(profileId)
    expect(pending.tier_id).toBe(previous)
    expect(JSON.parse(pending.metadata).plan_request.status).toBe('pending_review')
    const approved = await request(app).put(`/api/billing/accounts/${profileId}`).set(TEST_ADMIN_AUTH_HEADER).send({ tier_id: 'growth' })
    expect(approved.status).toBe(200)
    expect(JSON.parse(db.prepare('SELECT metadata FROM billing_accounts WHERE profile_id = ?').get(profileId).metadata).plan_request.status).toBe('approved')
  })

  it('rejects anonymous and unrelated account plan requests, and invalid tiers', async () => {
    expect((await request(app).post(`/api/billing/me/${profileId}/plan-request`).send({ tier_id: 'growth' })).status).toBe(401)
    const isolated = express()
    isolated.use(express.json(), (req, res, next) => { req.db = db; req.user = { userId: 'unrelated-user' }; req.ctx = { isAdmin: false }; next() })
    isolated.use('/billing', billingRouter)
    expect((await request(isolated).post(`/billing/me/${profileId}/plan-request`).send({ tier_id: 'growth' })).status).toBe(403)
    expect((await request(app).post(`/api/billing/me/${profileId}/plan-request`).set(TEST_ADMIN_AUTH_HEADER).send({ tier_id: 'invented' })).status).toBe(400)
  })

  it('computes the entire unpaid balance even beyond the invoice page and excludes paid/void invoices', async () => {
    await request(app).get(`/api/billing/me/${profileId}`).set(TEST_ADMIN_AUTH_HEADER)
    const insert = db.prepare(`INSERT INTO billing_invoices (id, profile_id, cadence, period_key, amount_cents, currency, status, paid_at) VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?)`)
    for (let i = 0; i < 105; i++) insert.run(`invoice-${i}`, profileId, `period-${i}`, 100, 'USD', 'sent', null)
    insert.run('paid', profileId, 'paid', 99000, 'USD', 'paid', '2026-09-01')
    insert.run('void', profileId, 'void', 99000, 'USD', 'void', null)
    insert.run('settled', profileId, 'settled', 99000, 'USD', 'sent', '2026-09-01')
    insert.run('eur', profileId, 'eur', 700, 'EUR', 'second_notice', null)
    const response = await request(app).get(`/api/billing/me/${profileId}/invoices`).set(TEST_ADMIN_AUTH_HEADER)
    expect(response.status).toBe(200)
    expect(response.body.invoices).toHaveLength(100)
    expect(response.body.open_invoices).toHaveLength(106)
    expect(response.body.open_invoices.map(invoice => invoice.id)).not.toContain('paid')
    expect(response.body.balances).toEqual(expect.arrayContaining([
      { currency: 'USD', amount_cents: 10500, invoice_count: 105 },
      { currency: 'EUR', amount_cents: 700, invoice_count: 1 },
    ]))
  })
})
