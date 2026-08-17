import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/accessControl.js', () => ({
  ensureProfileAccess: async () => true,
  getAuthUserId: (user) => user?.userId ?? null,
  // Represents the real helper's DB lookup: only this fixture's persisted admin
  // identity resolves true; token role/claims are deliberately ignored.
  isAdminUserWithDb: async (_db, user) => user?.userId === 'admin-1',
  requireAuthenticatedUserMiddleware: (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    return next()
  },
}))

vi.mock('../services/profileMemoryRepository.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createProfileMemory: async (_db, input) => {
      if (input.retentionPolicy === 'legal_hold' && !input.actorIsAdmin) {
        throw new actual.ProfileMemoryError(
          'MEMORY_ADMIN_REQUIRED',
          'Only a database-verified administrator may create a legal hold',
        )
      }
      return { id: 'memory-1', profile_id: input.profileId, status: 'active' }
    },
    deleteProfileMemoryEntry: async (_db, input) => ({
      id: input.entryId,
      profile_id: input.profileId,
      status: 'deleted',
    }),
    getProfileMemoryDeletionReadiness: async () => ({ can_delete: true, blocks: [] }),
    getProfileMemoryEntry: async () => ({ id: 'memory-1', status: 'active' }),
    listProfileMemory: async () => [],
    listProfileMemoryRevisions: async () => [],
    reviseProfileMemory: async () => ({ id: 'memory-1', status: 'active' }),
    setProfileMemoryRetention: async (_db, input) => {
      if (!input.actorIsAdmin) {
        throw new actual.ProfileMemoryError(
          'MEMORY_ADMIN_REQUIRED',
          'Only a database-verified administrator may change or release a retention policy',
        )
      }
      return { id: 'memory-1', status: 'active', retention_policy: input.retentionPolicy }
    },
  }
})

import profileMemoryRouter from '../routes/profileMemory.js'

function appFor(userId) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { userId, role: 'user' }
    req.ctx = { userId }
    req.db = {
      prepare: () => ({
        get: async () => ({ user_id: 'owner-1' }),
      }),
    }
    next()
  })
  app.use('/api/profiles', profileMemoryRouter)
  return app
}

describe('profile memory owner/admin authorization', () => {
  it('denies collaborator erasure while permitting the owner and DB-backed admin', async () => {
    await request(appFor('collaborator-1'))
      .delete('/api/profiles/profile-1/memory/memory-1')
      .send({ reason: 'collaborator_requested' })
      .expect(403)

    const owner = await request(appFor('owner-1'))
      .delete('/api/profiles/profile-1/memory/memory-1')
      .send({ reason: 'owner_requested' })
      .expect(200)
    expect(owner.body.redacted).toBe(true)

    await request(appFor('admin-1'))
      .delete('/api/profiles/profile-1/memory/memory-1')
      .send({ reason: 'admin_requested' })
      .expect(200)
  })

  it('allows only a DB-backed admin to create a legal hold', async () => {
    const body = {
      memory_key: 'hold-note',
      title: 'Hold note',
      kind: 'fact',
      value: { text: 'Preserved' },
      retention_policy: 'legal_hold',
      legal_hold_reason: 'Preservation request 24-17',
    }
    const collaborator = await request(appFor('collaborator-1'))
      .post('/api/profiles/profile-1/memory')
      .send(body)
      .expect(403)
    expect(collaborator.body.code).toBe('MEMORY_ADMIN_REQUIRED')

    const owner = await request(appFor('owner-1'))
      .post('/api/profiles/profile-1/memory')
      .send(body)
      .expect(403)
    expect(owner.body.code).toBe('MEMORY_ADMIN_REQUIRED')

    await request(appFor('admin-1'))
      .post('/api/profiles/profile-1/memory')
      .send(body)
      .expect(201)
  })

  it('keeps redacted history and revision metadata owner/admin-only', async () => {
    await request(appFor('collaborator-1'))
      .get('/api/profiles/profile-1/memory?include_deleted=true')
      .expect(403)
    await request(appFor('collaborator-1'))
      .get('/api/profiles/profile-1/memory/memory-1/revisions')
      .expect(403)
    await request(appFor('owner-1'))
      .get('/api/profiles/profile-1/memory/memory-1/revisions')
      .expect(200)
  })

  it('keeps every retention mutation DB-backed-admin-only', async () => {
    const change = {
      retention_policy: 'until_date',
      retention_until: '2027-01-01T00:00:00.000Z',
    }
    const owner = await request(appFor('owner-1'))
      .put('/api/profiles/profile-1/memory/memory-1/retention')
      .send(change)
      .expect(403)
    expect(owner.body.code).toBe('MEMORY_ADMIN_REQUIRED')

    const admin = await request(appFor('admin-1'))
      .put('/api/profiles/profile-1/memory/memory-1/retention')
      .send(change)
      .expect(200)
    expect(admin.body.item.retention_policy).toBe('until_date')
  })
})
