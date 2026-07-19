/**
 * SECURITY REGRESSION (fail-open IDOR).
 *
 * loadApplication() previously ran ensureProfileAccess ONLY when the row's
 * profile_id was truthy. A grant_applications row with profile_id IS NULL was
 * returned to ANY authenticated user, exposing read/write of another tenant's
 * orphaned application. The fix fails CLOSED: a non-admin hitting a NULL-profile
 * application must get 403; only admins may touch orphan rows.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

const workflowRouter = (await import('../routes/applicationWorkflow.js')).default

function dbStubReturning(row) {
  return {
    dialect: 'sqlite',
    exec() {},
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from grant_applications where id = ?')) {
        return { get: () => row }
      }
      // Any other query in this test path returns nothing.
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
}

function makeApp({ user, ctx, row }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = dbStubReturning(row)
    req.user = user
    req.ctx = ctx
    next()
  })
  app.use('/', workflowRouter)
  return app
}

const ORPHAN = { id: 'orphan-1', profile_id: null, user_id: null, status: 'draft' }

describe('applicationWorkflow orphan (NULL profile_id) access guard', () => {
  it('DENIES a non-admin reading a NULL-profile application (403, fail-closed)', async () => {
    const app = makeApp({
      user: { role: 'user', userId: 'attacker' },
      ctx: { isAdmin: false, accessibleProfileIds: new Set() },
      row: ORPHAN,
    })
    const res = await request(app).get('/orphan-1')
    expect(res.status).toBe(403)
  })

  it('DENIES a non-admin completing a step on a NULL-profile application (403)', async () => {
    // /steps/:stepId/complete resolves the app via a JOIN; stub returns a NULL
    // profile_id row for that query shape too.
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = {
        dialect: 'sqlite',
        exec() {},
        prepare(sql) {
          const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
          if (norm.includes('from application_steps')) {
            return { get: () => ({ id: 's1', application_id: 'orphan-1', profile_id: null }) }
          }
          return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
        },
      }
      req.user = { role: 'user', userId: 'attacker' }
      req.ctx = { isAdmin: false, accessibleProfileIds: new Set() }
      next()
    })
    app.use('/', workflowRouter)
    const res = await request(app).patch('/steps/s1/complete')
    expect(res.status).toBe(403)
  })

  it('returns 404 (not 403) for a genuinely missing application', async () => {
    const app = makeApp({
      user: { role: 'user', userId: 'someone' },
      ctx: { isAdmin: false, accessibleProfileIds: new Set() },
      row: null,
    })
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
  })
})
