import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import accessGateRouter from '../routes/accessGate.js'

const SERVER_SOURCE = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')
const FRONTEND_CLIENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/api/accessGate.js', import.meta.url)),
  'utf8',
)

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

/**
 * WIRED-BUT-UNREACHABLE GUARD.
 *
 * Every test above builds its OWN express app and mounts the router by hand,
 * so all four passed for months while `backend/server.js` never mounted
 * `/api/access-gate` at all. In production the endpoint 404'd, `<RequirePaidAccess>`
 * caught the failure, and EVERY authenticated user — admins included — saw
 * "We couldn't verify your access" on every payment-gated route.
 *
 * A route module's behavior test can never prove the route is reachable. This
 * block asserts the mount itself, and asserts that every path the frontend
 * access-gate client calls is covered by that mount.
 */
describe('the /api/access-gate router is MOUNTED in the real server', () => {
  it('backend/server.js mounts /api/access-gate on routes/accessGate.js', () => {
    // Tolerant of quote style and of lazyRouter vs a direct import, strict about
    // the mount path and the module it resolves to.
    const mountPattern =
      /app\.use\(\s*['"`]\/api\/access-gate['"`]\s*,[^\n]*accessGate\.js/
    expect(SERVER_SOURCE).toMatch(mountPattern)
  })

  it('every path the frontend access-gate client calls lives under the mounted prefix', () => {
    const calledPaths = Array.from(
      FRONTEND_CLIENT_SOURCE.matchAll(/apiFetch\(\s*[`'"](\/api\/[^`'"$?]+)/g),
      (m) => m[1],
    )
    // The client must actually be calling something, or this guard is vacuous.
    expect(calledPaths.length).toBeGreaterThan(0)
    for (const path of calledPaths) {
      expect(path.startsWith('/api/access-gate/')).toBe(true)
    }
  })

  it('the mount is not shadowed by the catch-all 404 handler', () => {
    const mountIndex = SERVER_SOURCE.search(/app\.use\(\s*['"`]\/api\/access-gate['"`]/)
    const notFoundIndex = SERVER_SOURCE.search(/res\.status\(404\)\.json\(\{\s*error:\s*['"`]Not found['"`]/)
    expect(mountIndex).toBeGreaterThan(-1)
    expect(notFoundIndex).toBeGreaterThan(-1)
    expect(mountIndex).toBeLessThan(notFoundIndex)
  })
})
