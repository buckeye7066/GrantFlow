import test from 'node:test'
import assert from 'node:assert/strict'

import { profileContextMiddleware } from '../../backend/middleware/profileContext.js'
import { getProfileContext } from '../../backend/db/scopedQuery.js'

function runMiddleware(req) {
  let seen = null
  profileContextMiddleware()(req, {}, () => {
    seen = getProfileContext()
  })
  return seen
}

test('profileContextMiddleware extracts profile id from matching route paths', () => {
  const ctx = runMiddleware({
    method: 'GET',
    originalUrl: '/api/matching/profile/profile-abc/opportunities?min_score=0',
    headers: {},
    query: {},
    ctx: { userId: 'user-1', isAdmin: false },
    user: { role: 'user' },
  })

  assert.equal(ctx.profileId, 'profile-abc')
  assert.equal(ctx.userId, 'user-1')
  assert.equal(ctx.actorRole, 'user')
})

test('profileContextMiddleware uses DB-backed admin context for role bypass', () => {
  const ctx = runMiddleware({
    method: 'GET',
    originalUrl: '/api/admin/health',
    headers: {},
    query: {},
    ctx: { userId: 'admin-1', isAdmin: true },
    user: { role: 'user' },
  })

  assert.equal(ctx.userId, 'admin-1')
  assert.equal(ctx.actorRole, 'admin')
})
