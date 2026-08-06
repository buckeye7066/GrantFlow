import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import accessGateRouter from '../routes/accessGate.js'

function createApp({ user, ctx, db = null }) {
  const app = express()
  app.use((req, _res, next) => {
    req.user = user
    req.ctx = ctx
    req.db = db
    next()
  })
  app.use('/api/access-gate', accessGateRouter)
  return app
}

describe('GET /api/access-gate/status canonical authority', () => {
  it('does not honor stale admin fields from the raw JWT user', async () => {
    const app = createApp({
      user: { userId: 'user-1', role: 'admin', is_admin: true, email: 'admin@example.test' },
      ctx: {
        userId: 'user-1',
        identityResolved: true,
        isAdmin: false,
        activeProfileId: 'profile-1',
        accessibleProfileIds: new Set(['profile-1']),
      },
    })

    const response = await request(app).get('/api/access-gate/status')

    expect(response.status).toBe(200)
    expect(response.body.authenticated).toBe(true)
    expect(response.body.is_admin).toBe(false)
    expect(response.body.access_granted).toBe(false)
    expect(response.body.blocking_reason).toBe('pricing_tables_not_installed')
  })

  it('fails closed when the canonical request identity is unresolved', async () => {
    const app = createApp({
      user: { userId: 'deleted-user', role: 'admin', is_admin: true },
      ctx: {
        userId: 'deleted-user',
        identityResolved: false,
        isAdmin: false,
        activeProfileId: null,
        accessibleProfileIds: new Set(),
      },
    })

    const response = await request(app).get('/api/access-gate/status?profile_id=another-profile')

    expect(response.status).toBe(200)
    expect(response.body.authenticated).toBe(false)
    expect(response.body.is_admin).toBe(false)
    expect(response.body.access_granted).toBe(false)
    expect(response.body.blocking_reason).toBe('not_authenticated')
    expect(response.body.profile_id).toBeUndefined()
  })

  it('preserves the canonical bypass for a validated synthetic service principal', async () => {
    const app = createApp({
      user: { userId: 'system_admin_token', role: 'admin', serviceToken: true },
      ctx: {
        userId: 'system_admin_token',
        identityResolved: true,
        isAdmin: true,
        activeProfileId: null,
        accessibleProfileIds: null,
      },
    })

    const response = await request(app).get('/api/access-gate/status')

    expect(response.status).toBe(200)
    expect(response.body.authenticated).toBe(true)
    expect(response.body.is_admin).toBe(true)
    expect(response.body.access_granted).toBe(true)
    expect(response.body.payment_status).toBe('admin_bypass')
  })

  it('rejects a non-admin status lookup outside the DB-resolved profile set', async () => {
    const app = createApp({
      user: { userId: 'user-1' },
      ctx: {
        userId: 'user-1',
        identityResolved: true,
        isAdmin: false,
        activeProfileId: 'profile-1',
        accessibleProfileIds: new Set(['profile-1']),
      },
    })

    const response = await request(app).get('/api/access-gate/status?profile_id=profile-2')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: 'profile_access_denied' })
  })
})
