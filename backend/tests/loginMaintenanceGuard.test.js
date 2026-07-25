// LOGIN MAINTENANCE GUARD (backend/routes/auth.js + backend/config/maintenance.js)
//
// While LOGIN_MAINTENANCE=1, every session-CREATING endpoint on the auth
// router returns 503 so no new sign-ins can complete — but existing sessions
// keep working: /refresh, /logout, and /onboarding-state (a logged-in user's
// state mutation) must pass through untouched. A GET OAuth provider callback
// is a top-level browser navigation, so it must REDIRECT to the frontend
// banner (?error=maintenance), never show raw JSON. Default is OFF so every
// CI lane exercises the real auth flows.
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import authRouter from '../routes/auth.js'

// The full session-creating surface of the router (parity-style enumeration:
// if a new sign-in endpoint is added, add it here or exempt it deliberately).
const SESSION_CREATING_ENDPOINTS = [
  '/api/auth/email/start',
  '/api/auth/email/verify',
  '/api/auth/phone/start',
  '/api/auth/phone/verify',
  '/api/auth/access/check',
  '/api/auth/password/setup/start',
  '/api/auth/password/reset/start',
  '/api/auth/password/setup/complete',
  '/api/auth/password/login',
]

const EXEMPT_ENDPOINTS = [
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/onboarding-state',
]

function buildApp() {
  const app = express()
  app.use(express.json())
  // The guard fires before any DB access; a bare object is enough.
  app.use((req, _res, next) => { req.db = {}; next() })
  app.use('/api/auth', authRouter)
  return app
}

describe('login maintenance guard', () => {
  let savedFlag

  beforeEach(() => {
    savedFlag = process.env.LOGIN_MAINTENANCE
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.LOGIN_MAINTENANCE
    else process.env.LOGIN_MAINTENANCE = savedFlag
  })

  it('returns 503 on every session-creating endpoint while active', async () => {
    process.env.LOGIN_MAINTENANCE = '1'
    const app = buildApp()

    for (const path of SESSION_CREATING_ENDPOINTS) {
      const res = await request(app).post(path).send({})
      expect(res.status, path).toBe(503)
      expect(res.body.error, path).toBe('maintenance')
      expect(res.body.message, path).toMatch(/upgraded/i)
    }
  })

  it('lets existing-session endpoints through while active (never 503)', async () => {
    process.env.LOGIN_MAINTENANCE = '1'
    const app = buildApp()

    for (const path of EXEMPT_ENDPOINTS) {
      const method = path.endsWith('/onboarding-state') ? 'patch' : 'post'
      const res = await request(app)[method](path).send({})
      // Downstream handlers will 401/500 on the stub DB — the contract here
      // is only that the MAINTENANCE guard did not intercept.
      expect(res.status, path).not.toBe(503)
    }
  })

  it('tolerates a trailing slash on an exempt path', async () => {
    process.env.LOGIN_MAINTENANCE = '1'
    const app = buildApp()

    const res = await request(app).post('/api/auth/refresh/').send({})
    expect(res.status).not.toBe(503)
  })

  it('redirects a GET OAuth callback to the frontend with error=maintenance', async () => {
    process.env.LOGIN_MAINTENANCE = '1'
    const app = buildApp()

    const res = await request(app).get('/api/auth/google/callback?code=x&state=y')
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('error=maintenance')
    expect(res.headers.location).toContain('/auth/callback')
  })

  it('is OFF by default: sign-in endpoints are never 503 without the flag', async () => {
    delete process.env.LOGIN_MAINTENANCE
    const app = buildApp()

    for (const path of SESSION_CREATING_ENDPOINTS) {
      const res = await request(app).post(path).send({})
      expect(res.status, path).not.toBe(503)
    }
  })

  it('LOGIN_MAINTENANCE=0 explicitly disarms the guard', async () => {
    process.env.LOGIN_MAINTENANCE = '0'
    const app = buildApp()

    const res = await request(app).post('/api/auth/password/login').send({})
    expect(res.status).not.toBe(503)
  })
})
