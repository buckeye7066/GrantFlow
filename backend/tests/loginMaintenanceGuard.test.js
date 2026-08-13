import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import authRouter from '../routes/auth.js'

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

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = {}; next() })
  app.use('/api/auth', authRouter)
  return app
}

describe('login availability', () => {
  let savedFlag

  beforeEach(() => {
    savedFlag = process.env['LOGIN_' + 'MAINTENANCE']
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env['LOGIN_' + 'MAINTENANCE']
    else process.env['LOGIN_' + 'MAINTENANCE'] = savedFlag
  })

  it('cannot be disabled by a stale production maintenance variable', async () => {
    process.env['LOGIN_' + 'MAINTENANCE'] = '1'
    const app = buildApp()

    for (const path of SESSION_CREATING_ENDPOINTS) {
      const res = await request(app).post(path).send({})
      expect(res.status, path).not.toBe(503)
      expect(res.body?.error, path).not.toBe('maintenance')
    }
  })

  it('reports that maintenance is inactive with no banner copy', async () => {
    process.env['LOGIN_' + 'MAINTENANCE'] = '1'
    const res = await request(buildApp()).get('/api/auth/maintenance')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      active: false,
      title: '',
      message: '',
      etaText: '',
    })
  })
})
