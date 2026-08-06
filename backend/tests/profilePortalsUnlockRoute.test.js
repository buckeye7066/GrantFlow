/**
 * Integration tests for POST /api/profiles/:id/portal-autopilot/unlock.
 *
 * REGRESSION GUARD for the "session destroyed by a wrong passphrase" bug:
 *
 *   A failed vault unlock (wrong passphrase, or no passphrase set) is a DOMAIN
 *   authorization failure, NOT an HTTP-session auth failure. It MUST return 403,
 *   never 401. The frontend APIClient treats any 401 on a non-/api/auth endpoint
 *   as an expired access token, so it would force a token refresh, retry, get the
 *   same 401 ("Still getting 401 after refresh, giving up"), then clear the tokens
 *   and mark the session expired — logging the owner out over a mistyped passphrase.
 *
 * These tests pin the status codes so the unlock route can never regress back to
 * 401 for a domain failure.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Encryption key (32 bytes as 64 hex chars) must exist before the vault service
// derives any key, mirroring the unit-test harness.
process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const profilePortalsRouter = (await import('../routes/profilePortals.js')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const { setMasterPassphrase, _resetMasterVaultSchemaCache, _resetUnlockCache } = await import(
  '../services/hamilton/hamiltonPortalMasterVault.js'
)

const PROFILE_ID = '00000000-0000-4000-8000-000000000001'

// Build an app whose injected user is an admin. Admin access is DB-backed
// (req.ctx.isAdmin), resolved by the real attachRequestContext middleware, so
// the admin fast-path in userMayAccessProfile is exercised faithfully without
// needing the full users/profiles access graph — we are testing the
// unlock-failure status, not access.
function createApp(db, user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = user
    next()
  })
  app.use(attachRequestContext())
  app.use('/api', profilePortalsRouter)
  return app
}

describe('POST /api/profiles/:id/portal-autopilot/unlock — status codes', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetMasterVaultSchemaCache()
    _resetUnlockCache()
  })

  it('returns 401 when the request itself is unauthenticated', async () => {
    const app = createApp(db, { role: 'guest' })
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({ passphrase: 'anything' })
    expect(res.status).toBe(401)
  })

  it('returns 400 (not 401) when no passphrase is supplied', async () => {
    const app = createApp(db, { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' })
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('passphrase required')
  })

  it('returns 403 (NOT 401) when no passphrase has been set for the profile', async () => {
    const app = createApp(db, { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' })
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({ passphrase: 'whatever' })
    // The critical assertion: a domain unlock failure is 403, never 401, so the
    // APIClient never nukes the owner's session.
    expect(res.status).toBe(403)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('unlock_failed')
  })

  it('returns 403 (NOT 401) on a WRONG passphrase', async () => {
    await setMasterPassphrase(db, { profileId: PROFILE_ID, passphrase: 'the-right-one' })
    const app = createApp(db, { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' })
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({ passphrase: 'the-wrong-one' })
    expect(res.status).toBe(403)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('unlock_failed')
  })

  it('returns 200 with vault status on the CORRECT passphrase', async () => {
    await setMasterPassphrase(db, { profileId: PROFILE_ID, passphrase: 'the-right-one' })
    _resetUnlockCache() // ensure unlock derives fresh, not a cached key from setMasterPassphrase
    const app = createApp(db, { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' })
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({ passphrase: 'the-right-one' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.vault).toBeTruthy()
  })
})
