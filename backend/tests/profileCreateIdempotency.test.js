import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

const profilesRouter = (await import('../routes/profiles.js')).default

// POST /api/profiles used to 500 with "duplicate key value violates unique
// constraint ux_profiles_user_id" when a user who already owned a profile
// submitted a second create (prod, 2026-07-13). One owned profile per user is
// the product rule — the route must answer 409 with the existing id, both on
// the pre-check and on the insert race.

function createApp(db, ctx) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.ctx = ctx
    next()
  })
  app.use('/api/profiles', profilesRouter)
  return app
}

describe('POST /api/profiles idempotency (ux_profiles_user_id)', () => {
  it('returns 409 with the existing profile id when the user already owns a profile', async () => {
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (normalized === 'select id from profiles where user_id = ?') {
          return { get: () => ({ id: 'profile-existing' }) }
        }
        throw new Error(`Unexpected SQL in profileCreateIdempotency.test.js: ${sql}`)
      },
      withTransaction() {
        throw new Error('withTransaction must not run when the pre-check finds an existing profile')
      },
    }

    const res = await request(createApp(db, { userId: 'user-1', isAdmin: false }))
      .post('/api/profiles')
      .send({ display_name: 'Second profile attempt' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_EXISTS')
    expect(res.body.existing_profile_id).toBe('profile-existing')
  })

  it('returns 409 (not 500) when a concurrent create loses the unique-index race', async () => {
    // Pre-check sees nothing; the racing winner's row is visible by the time
    // the loser's INSERT bounces off ux_profiles_user_id.
    let lookups = 0
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (normalized === 'select id from profiles where user_id = ?') {
          lookups += 1
          return { get: () => (lookups === 1 ? null : { id: 'profile-winner' }) }
        }
        throw new Error(`Unexpected SQL in profileCreateIdempotency.test.js: ${sql}`)
      },
      async withTransaction() {
        const err = new Error('duplicate key value violates unique constraint "ux_profiles_user_id"')
        err.code = '23505'
        throw err
      },
    }

    const res = await request(createApp(db, { userId: 'user-1', isAdmin: false }))
      .post('/api/profiles')
      .send({ display_name: 'Racing profile attempt' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_EXISTS')
    expect(res.body.existing_profile_id).toBe('profile-winner')
  })

  it('admin creating an UNOWNED profile (user_id null) skips the pre-check', async () => {
    // profileUserId is null for admin creates without an explicit user_id —
    // the unique index does not apply to NULLs, so no lookup should happen.
    // The transaction stub throws a NON-unique error so the request surfaces
    // it (proving we did not swallow it as a 409) without stubbing the whole
    // downstream create pipeline.
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        throw new Error(`Unexpected SQL in profileCreateIdempotency.test.js: ${sql}`)
      },
      async withTransaction() {
        const err = new Error('sentinel: reached the insert transaction')
        throw err
      },
    }

    const res = await request(createApp(db, { userId: 'admin-1', isAdmin: true }))
      .post('/api/profiles')
      .send({ display_name: 'Admin-created client profile' })

    expect(res.status).toBe(500)
  })
})
