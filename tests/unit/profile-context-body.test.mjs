import test from 'node:test'
import assert from 'node:assert/strict'

import { profileContextMiddleware, getProfileContext } from '../../backend/middleware/profileContext.js'

test('profileContextMiddleware reads profile_id from JSON request bodies', async () => {
  const middleware = profileContextMiddleware()
  const req = {
    method: 'POST',
    originalUrl: '/api/ai/discover-needs',
    body: { profile_id: 'profile-body-1' },
    query: {},
    headers: {},
    user: { id: 'user-1', role: 'user' },
  }

  await new Promise((resolve, reject) => {
    middleware(req, {}, (err) => {
      if (err) return reject(err)
      try {
        const ctx = getProfileContext()
        assert.equal(ctx.profileId, 'profile-body-1')
        assert.equal(ctx.userId, 'user-1')
        assert.equal(ctx.route, 'POST /api/ai/discover-needs')
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
})
