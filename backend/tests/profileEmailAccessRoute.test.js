import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_EMAIL } from '../config/constants.js'

const profilesRouter = (await import('../routes/profiles.js')).default

function createDbStub() {
  const profiles = new Map([
    ['profile-shared', { id: 'profile-shared', display_name: 'Shared profile', user_id: 'owner-user', created_by: null, status: 'active' }],
  ])
  const profileEmails = [
    {
      id: 'email-owner',
      profile_id: 'profile-shared',
      email: 'owner@example.test',
      added_by: 'owner-user',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'email-shared',
      profile_id: 'profile-shared',
      email: 'shared@example.test',
      added_by: 'owner-user',
      created_at: '2026-01-01T00:00:01.000Z',
    },
    {
      id: 'email-admin',
      profile_id: 'profile-shared',
      email: ADMIN_EMAIL,
      added_by: 'owner-user',
      created_at: '2026-01-01T00:00:02.000Z',
    },
  ]

  return {
    dialect: 'sqlite',
    exec() {},
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (normalized.includes('select user_id, created_by, status from profiles where id = ?')) {
        return {
          get(profileId) {
            const profile = profiles.get(String(profileId))
            if (!profile) return null
            return {
              user_id: profile.user_id,
              created_by: profile.created_by,
              status: profile.status,
            }
          },
        }
      }
      if (normalized.includes('select id, profile_id, email, added_by, created_at') && normalized.includes('from profile_emails')) {
        return {
          all(profileId) {
            return profileEmails.filter((row) => row.profile_id === String(profileId))
          },
        }
      }
      if (normalized.includes('select data from profile_sections') && normalized.includes("section_key = 'automation_preferences'")) {
        return {
          get() {
            return null
          },
        }
      }
      throw new Error(`Unexpected SQL in profileEmailAccessRoute.test.js: ${sql}`)
    },
  }
}

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

describe('profile email access routes', () => {
  it('allows an email-shared profile user to view profile login emails', async () => {
    const db = createDbStub()
    const app = createApp(db, {
      userId: 'shared-user',
      email: 'shared@example.test',
      isAdmin: false,
      accessibleProfileIds: new Set(['profile-shared']),
    })

    const res = await request(app).get('/api/profiles/profile-shared/emails')

    expect(res.status).toBe(200)
    const visibleEmails = res.body.emails.map((row) => row.email)
    expect(visibleEmails).toEqual(expect.arrayContaining(['owner@example.test', 'shared@example.test']))
    expect(visibleEmails).not.toContain(ADMIN_EMAIL)
    expect(visibleEmails).toHaveLength(2)
  })

  it('allows an email-shared profile user to view the portal access schedule', async () => {
    const db = createDbStub()
    const app = createApp(db, {
      userId: 'shared-user',
      email: 'shared@example.test',
      isAdmin: false,
      accessibleProfileIds: new Set(['profile-shared']),
    })

    const res = await request(app).get('/api/profiles/profile-shared/portal-access-schedule')

    expect(res.status).toBe(200)
    expect(res.body.schedule).toBeTruthy()
  })

  it('still blocks a user with no access to the profile', async () => {
    const db = createDbStub()
    const app = createApp(db, {
      userId: 'other-user',
      email: 'other@example.test',
      isAdmin: false,
      accessibleProfileIds: new Set(),
    })

    const res = await request(app).get('/api/profiles/profile-shared/emails')

    expect(res.status).toBe(403)
  })
})
