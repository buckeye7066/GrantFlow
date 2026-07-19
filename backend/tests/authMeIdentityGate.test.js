/**
 * SECURITY REGRESSION (round 17): GET /api/auth/me is a user-scoped READ that
 * lives under the /api/auth* prefix, which is EXEMPT from the enforceResolvedIdentity
 * structural gate (identity-establishing endpoints must run pre-identity). Before
 * this fix the handler read `users` by the RAW req.user.userId before checking
 * identityResolved — so a synthetic-collision JWT (sub=system_admin_token, no
 * serviceToken) found the self-healed reserved row and got a 200 user payload, and
 * a deleted-user JWT read its stale row. The handler now requires a DB-resolved
 * identity (or DB-backed admin) and sources the id from req.ctx.userId.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { getAppAndDb, resetDb } from './testServer.js'

// Matches the deterministic non-prod fallback in backend/config/env.js.
const DEV_JWT_SECRET = 'grantflow-dev-secret'
const sign = (payload) => jwt.sign(payload, DEV_JWT_SECRET, { algorithm: 'HS256', expiresIn: 3600 })

let app, db
beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
})

beforeEach(() => {
  resetDb(db)
  // A real, resolvable user...
  db.prepare("INSERT INTO users (id, primary_email, is_admin) VALUES ('u-me', 'me@example.com', 0)").run()
  // ...and the self-healed RESERVED synthetic-admin row that a colliding JWT would target.
  db.prepare("INSERT INTO users (id, primary_email, is_admin) VALUES ('system_admin_token', 'svc@grantflow.app', 1)").run()
})

describe('GET /api/auth/me identity gate', () => {
  it('DENIES a synthetic-collision JWT (sub=system_admin_token, no service-token provenance)', async () => {
    const token = sign({ sub: 'system_admin_token', roles: ['user'] })
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
    // Must NOT leak the reserved row's payload.
    expect(res.body?.user?.id).toBeUndefined()
    expect(res.body?.user?.is_admin).toBeUndefined()
  })

  it('DENIES a deleted-user JWT (no users row)', async () => {
    const token = sign({ sub: 'ghost-deleted-user', roles: ['user'] })
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('ALLOWS a real resolved user and returns their own row', async () => {
    const token = sign({ sub: 'u-me', roles: ['user'] })
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body?.user?.id).toBe('u-me')
    expect(res.body?.user?.is_admin).toBe(false)
  })
})
