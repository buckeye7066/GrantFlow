/**
 * Health-endpoint gating (epic slice 9): the operational-detail endpoints
 * (mission gate, alerts, data readiness, deployment identity, storage paths,
 * import validation) used to ride the early PUBLIC health mount — catalog
 * counts, the application funnel, commit SHAs and filesystem detail were
 * readable by anyone. They now live on sensitiveHealthRouter, mounted behind
 * ensureAuth in server.js, with an internal ADMIN requirement on everything
 * except /mission (the production-audit account is non-admin BY CONTRACT and
 * reads /mission as its status probe).
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import healthRouter, { sensitiveHealthRouter } from '../routes/health.js'
import { ensureAuth } from '../middleware/auth.js'

const SENSITIVE_PATHS = ['/storage', '/data-readiness', '/alerts', '/deployment', '/mission', '/imports']

function fakeDb() {
  return {
    dialect: 'sqlite',
    prepare() { return { get: async () => ({ ok: 1 }), all: async () => [], run: async () => ({ changes: 0 }) } },
  }
}

// Mirrors the production mount shape in backend/server.js: public router
// early, sensitive router behind ensureAuth at /api/health.
function createApp({ user = null, ctx = null } = {}) {
  const app = express()
  app.use((req, _res, next) => {
    if (user) { req.user = user; req.ctx = ctx }
    req.db = fakeDb()
    next()
  })
  app.use(healthRouter)
  app.use('/api/health', ensureAuth, sensitiveHealthRouter)
  return app
}

// ensureAuth keys on req.user.userId; ensureAdmin on req.ctx.isAdmin.
const ADMIN = { user: { userId: 'a', role: 'admin', is_admin: true }, ctx: { userId: 'a', isAdmin: true } }
const NON_ADMIN = { user: { userId: 'u', role: 'user' }, ctx: { userId: 'u', isAdmin: false, accessibleProfileIds: new Set(), accessibleOrgIds: new Set() } }

describe('public probes stay public', () => {
  it('/healthz answers without any identity', async () => {
    const res = await request(createApp()).get('/healthz')
    expect(res.status).toBeLessThan(500)
    expect(res.headers['content-type']).toMatch(/json/)
  })
})

describe('operational endpoints are OFF the public router', () => {
  it.each(SENSITIVE_PATHS)('unauthenticated GET /api/health%s is denied, never served', async (p) => {
    const res = await request(createApp()).get(`/api/health${p}`)
    expect(res.status).toBe(401)
  })
})

describe('the admin split inside the sensitive router', () => {
  it('a NON-admin is denied every deep-detail endpoint (403)', async () => {
    const app = createApp(NON_ADMIN)
    for (const p of SENSITIVE_PATHS.filter((x) => x !== '/mission')) {
      const res = await request(app).get(`/api/health${p}`)
      expect(res.status, p).toBe(403)
    }
  })

  it('a NON-admin CAN read /mission (the production-audit contract)', async () => {
    const res = await request(createApp(NON_ADMIN)).get('/api/health/mission')
    expect([200, 500, 503]).toContain(res.status) // authorized; body depends on db fixture
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  it('an admin reaches the deep-detail endpoints (authorized — not 401/403)', async () => {
    const app = createApp(ADMIN)
    for (const p of SENSITIVE_PATHS) {
      const res = await request(app).get(`/api/health${p}`)
      expect([401, 403]).not.toContain(res.status)
    }
  })
})
