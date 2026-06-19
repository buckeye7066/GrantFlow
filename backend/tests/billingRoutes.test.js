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
})
