/**
 * SECURITY REGRESSION (IDOR).
 *
 * POST /api/foundations/reverse-lookup loads the target profile's context and
 * returns its derived attributes (home state, entity type, need categories —
 * which encode sensitive facts). It previously ran WITHOUT ensureProfileAccess,
 * unlike its siblings /score and /profile-region. A non-admin must not be able
 * to reverse-look-up a profile they cannot access.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

const foundationsRouter = (await import('../routes/foundations.js')).default

// Deny-everything stub: user is not admin and has access to no profile, so
// ensureProfileAccess must 403 BEFORE the reverse-lookup service is imported.
function denyStub() {
  return {
    dialect: 'sqlite',
    exec() {},
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from users')) {
        return { get: () => ({ id: 'attacker', is_admin: 0 }), all: () => [] }
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = denyStub()
    req.user = { role: 'user', userId: 'attacker' }
    req.ctx = { isAdmin: false, accessibleProfileIds: new Set(), db: req.db }
    next()
  })
  app.use('/', foundationsRouter)
  return app
}

describe('foundations reverse-lookup access guard', () => {
  it('DENIES a non-admin reverse-lookup of an inaccessible profile (403)', async () => {
    const res = await request(makeApp())
      .post('/reverse-lookup')
      .send({ profile_id: 'victim-profile' })
    expect(res.status).toBe(403)
  })

  it('still 400s when profile_id is missing', async () => {
    const res = await request(makeApp()).post('/reverse-lookup').send({})
    expect(res.status).toBe(400)
  })
})
