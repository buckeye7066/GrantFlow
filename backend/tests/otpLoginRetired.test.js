// OTP code sign-in is RETIRED in production (2026-07-11).
//
// Every sign-in surface uses the password flow (/access/check →
// /password/login, or an emailed /set-password link). A stale cached
// frontend that still asks for a 6-digit code must get a clear 410 that
// points back to /Login — never a silently emailed code ("a code popped
// up when I tried to log in").
//
// PARITY CHECK (per the MIGRATION PARITY rule in CLAUDE.md): OTP_ENDPOINTS
// below enumerates the old system's full reachable surface — every
// code-based start/verify route the pre-password frontends could call.
// The onboarding funnel's code prompt (the fifth OTP surface) is pinned by
// backend/tests/onboardingRoute.test.js asserting /complete emits a
// password-setup link and NO verification token.
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import authRouter from '../routes/auth.js'

const OTP_ENDPOINTS = [
  '/api/auth/email/start',
  '/api/auth/email/verify',
  '/api/auth/phone/start',
  '/api/auth/phone/verify',
]

function buildApp() {
  const app = express()
  app.use(express.json())
  // The retirement gate fires before any DB access; a bare object is enough.
  app.use((req, _res, next) => { req.db = {}; next() })
  app.use('/api/auth', authRouter)
  return app
}

describe('OTP code login retirement', () => {
  const savedEnv = {}
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT', 'VERCEL_ENV', 'ALLOW_OTP_LOGIN']

  beforeEach(() => {
    for (const k of KEYS) savedEnv[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('every OTP endpoint returns 410 + a /Login redirect in production', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production'
    delete process.env.ALLOW_OTP_LOGIN
    const app = buildApp()

    for (const path of OTP_ENDPOINTS) {
      const res = await request(app).post(path).send({})
      expect(res.status, path).toBe(410)
      expect(res.body.error_type, path).toBe('code_login_retired')
      expect(res.body.redirect_to, path).toBe('/Login')
      expect(String(res.body.error), path).toMatch(/password link/i)
    }
  })

  it('stays available outside production (test/dev harness keeps working)', async () => {
    delete process.env.RAILWAY_ENVIRONMENT
    delete process.env.VERCEL_ENV
    process.env.NODE_ENV = 'test'
    const app = buildApp()

    // Reaches normal validation instead of the retirement gate.
    const res = await request(app).post('/api/auth/email/start').send({})
    expect(res.status).not.toBe(410)
  })

  it('ALLOW_OTP_LOGIN=true is an explicit production escape hatch', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production'
    process.env.ALLOW_OTP_LOGIN = 'true'
    const app = buildApp()

    const res = await request(app).post('/api/auth/email/start').send({})
    expect(res.status).not.toBe(410)
  })
})
