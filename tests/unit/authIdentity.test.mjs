/**
 * Unit tests for backend/middleware/authIdentity.js
 *
 * Tests all 5 auth flows in priority order:
 *   1. X-Admin-Token header authentication
 *   2. X-Anya-Token header authentication
 *   3. Bearer admin/bulk token via Authorization header
 *   4. Bearer Anya API key via Authorization header
 *   5. Bearer JWT (valid / expired / malformed) + DB session enrichment
 *   6. Legacy admin token fallback after JWT block
 *   7. Legacy profile-id bearer token (enabled vs. disabled)
 *   8. Guest fallback when no credentials provided
 *   9. Priority ordering (admin token takes precedence over JWT, etc.)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createAuthIdentityMiddleware } from '../../backend/middleware/authIdentity.js'

const JWT_SECRET = 'test-jwt-secret-unit'

/**
 * Minimal in-memory DB stub that handles prepare().get() / prepare().all()
 */
function makeDb(sessionRows = {}, profileRows = {}) {
  return {
    prepare(sql) {
      return {
        async get(id) {
          if (sql.includes('user_sessions')) {
            return sessionRows[id] ?? null
          }
          if (sql.includes('profiles')) {
            return profileRows[id] ?? null
          }
          return null
        },
        async all() {
          return []
        },
      }
    },
  }
}

/**
 * Helper that builds a mock Express request, runs the middleware, and returns req.user.
 */
async function resolveUser(headers, config = {}) {
  const db = config.db ?? makeDb()
  const adminToken = 'adminToken' in config ? config.adminToken : 'test-admin-token'
  const middleware = createAuthIdentityMiddleware({
    adminToken,
    adminName: config.adminName ?? 'Test Admin',
    adminEmail: config.adminEmail ?? 'admin@test.com',
    jwtSecret: config.jwtSecret ?? JWT_SECRET,
    db,
    isProd: config.isProd ?? false,
  })

  const req = { headers, user: null }
  let nextCalled = false
  await middleware(req, {}, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'next() must be called')
  return req.user
}

// ---------------------------------------------------------------------------
// 1. Guest fallback
// ---------------------------------------------------------------------------
test('authIdentity: no credentials → guest', async () => {
  const user = await resolveUser({})
  assert.equal(user.role, 'guest')
  assert.equal(user.profileId, null)
})

// ---------------------------------------------------------------------------
// 2. X-Admin-Token
// ---------------------------------------------------------------------------
test('authIdentity: X-Admin-Token matches adminToken → admin', async () => {
  const user = await resolveUser({ 'x-admin-token': 'test-admin-token' })
  assert.equal(user.role, 'admin')
  assert.equal(user.is_admin, true)
  assert.equal(user.userId, 'system_admin_token')
  assert.equal(user.email, 'admin@test.com')
})

test('authIdentity: X-Admin-Token matches BULK_POPULATE_KEY → admin', async () => {
  const savedBulk = process.env.BULK_POPULATE_KEY
  process.env.BULK_POPULATE_KEY = 'bulk-key-xyz'
  try {
    const user = await resolveUser({ 'x-admin-token': 'bulk-key-xyz' })
    assert.equal(user.role, 'admin')
    assert.equal(user.userId, 'system_admin_token')
  } finally {
    if (savedBulk === undefined) delete process.env.BULK_POPULATE_KEY
    else process.env.BULK_POPULATE_KEY = savedBulk
  }
})

test('authIdentity: X-Admin-Token wrong value → guest', async () => {
  const user = await resolveUser({ 'x-admin-token': 'wrong-token' })
  assert.equal(user.role, 'guest')
})

test('authIdentity: X-Admin-Token empty adminToken → guest', async () => {
  const user = await resolveUser({ 'x-admin-token': 'test-admin-token' }, { adminToken: '' })
  assert.equal(user.role, 'guest')
})

// ---------------------------------------------------------------------------
// 3. X-Anya-Token
// ---------------------------------------------------------------------------
test('authIdentity: X-Anya-Token matches ANYA_API_KEY → admin (anya)', async () => {
  const savedKey = process.env.ANYA_API_KEY
  process.env.ANYA_API_KEY = 'anya-key-123'
  try {
    const user = await resolveUser({ 'x-anya-token': 'anya-key-123' })
    assert.equal(user.role, 'admin')
    assert.equal(user.userId, 'system_anya_token')
    assert.equal(user.email, 'anya@grantflow.app')
  } finally {
    if (savedKey === undefined) delete process.env.ANYA_API_KEY
    else process.env.ANYA_API_KEY = savedKey
  }
})

test('authIdentity: X-Anya-Token wrong value → guest', async () => {
  const savedKey = process.env.ANYA_API_KEY
  process.env.ANYA_API_KEY = 'anya-key-123'
  try {
    const user = await resolveUser({ 'x-anya-token': 'wrong-anya-key' })
    assert.equal(user.role, 'guest')
  } finally {
    if (savedKey === undefined) delete process.env.ANYA_API_KEY
    else process.env.ANYA_API_KEY = savedKey
  }
})

// ---------------------------------------------------------------------------
// 4. Bearer admin token
// ---------------------------------------------------------------------------
test('authIdentity: Bearer adminToken → admin', async () => {
  const user = await resolveUser({ authorization: 'Bearer test-admin-token' })
  assert.equal(user.role, 'admin')
  assert.equal(user.userId, 'system_admin_token')
})

test('authIdentity: Bearer BULK_POPULATE_KEY → admin', async () => {
  const savedBulk = process.env.BULK_POPULATE_KEY
  process.env.BULK_POPULATE_KEY = 'bulk-bearer-key'
  try {
    const user = await resolveUser({ authorization: 'Bearer bulk-bearer-key' })
    assert.equal(user.role, 'admin')
    assert.equal(user.userId, 'system_admin_token')
  } finally {
    if (savedBulk === undefined) delete process.env.BULK_POPULATE_KEY
    else process.env.BULK_POPULATE_KEY = savedBulk
  }
})

// ---------------------------------------------------------------------------
// 5. Bearer Anya API key
// ---------------------------------------------------------------------------
test('authIdentity: Bearer Anya API key → admin (anya)', async () => {
  const savedKey = process.env.ANYA_API_KEY
  process.env.ANYA_API_KEY = 'anya-bearer-key'
  try {
    const user = await resolveUser({ authorization: 'Bearer anya-bearer-key' })
    assert.equal(user.role, 'admin')
    assert.equal(user.userId, 'system_anya_token')
  } finally {
    if (savedKey === undefined) delete process.env.ANYA_API_KEY
    else process.env.ANYA_API_KEY = savedKey
  }
})

// ---------------------------------------------------------------------------
// 6. Bearer JWT (valid)
// ---------------------------------------------------------------------------
test('authIdentity: valid JWT for regular user → user', async () => {
  const token = jwt.sign(
    { sub: 'user-uuid-1', email: 'user@example.com', name: 'Jane', roles: ['user'] },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  const user = await resolveUser({ authorization: `Bearer ${token}` })
  assert.equal(user.role, 'user')
  assert.equal(user.userId, 'user-uuid-1')
  assert.equal(user.email, 'user@example.com')
  assert.equal(user.is_admin, false)
})

test('authIdentity: valid JWT with admin role → admin', async () => {
  const token = jwt.sign(
    { sub: 'admin-uuid-1', email: 'admin@example.com', name: 'Admin', roles: ['admin'] },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  const user = await resolveUser({ authorization: `Bearer ${token}` })
  assert.equal(user.role, 'admin')
  assert.equal(user.is_admin, true)
  assert.equal(user.userId, 'admin-uuid-1')
})

test('authIdentity: expired JWT → guest', async () => {
  const token = jwt.sign({ sub: 'user-uuid-2', roles: [] }, JWT_SECRET, { expiresIn: '-1s' })
  const user = await resolveUser({ authorization: `Bearer ${token}` })
  assert.equal(user.role, 'guest')
})

test('authIdentity: malformed JWT → guest', async () => {
  const user = await resolveUser({ authorization: 'Bearer not.a.valid.jwt' })
  assert.equal(user.role, 'guest')
})

test('authIdentity: JWT signed with wrong secret → guest', async () => {
  const token = jwt.sign({ sub: 'user-uuid-3', roles: [] }, 'wrong-secret', { expiresIn: '1h' })
  const user = await resolveUser({ authorization: `Bearer ${token}` })
  assert.equal(user.role, 'guest')
})

// ---------------------------------------------------------------------------
// 7. JWT + DB session enrichment
// ---------------------------------------------------------------------------
test('authIdentity: JWT with sid enriches from DB session (non-revoked)', async () => {
  const sessionId = 'session-abc'
  const db = makeDb({
    [sessionId]: {
      id: sessionId,
      user_id: 'db-user-1',
      display_name: 'DB User',
      primary_email: 'dbuser@example.com',
      is_admin: false,
      revoked_at: null,
      refresh_expires_at: null,
      profile_id: 'profile-1',
    },
  })
  const token = jwt.sign({ sub: 'db-user-1', sid: sessionId, roles: ['user'] }, JWT_SECRET, {
    expiresIn: '1h',
  })
  const user = await resolveUser({ authorization: `Bearer ${token}` }, { db })
  assert.equal(user.userId, 'db-user-1')
  assert.equal(user.email, 'dbuser@example.com')
  assert.equal(user.sessionId, sessionId)
})

test('authIdentity: revoked DB session still allows JWT-only auth', async () => {
  const sessionId = 'session-revoked'
  const db = makeDb({
    [sessionId]: {
      id: sessionId,
      user_id: 'db-user-2',
      display_name: 'DB User 2',
      primary_email: 'dbuser2@example.com',
      is_admin: false,
      revoked_at: new Date().toISOString(), // revoked
      refresh_expires_at: null,
      profile_id: null,
    },
  })
  const token = jwt.sign({ sub: 'db-user-2', sid: sessionId, roles: ['user'] }, JWT_SECRET, {
    expiresIn: '1h',
  })
  const user = await resolveUser({ authorization: `Bearer ${token}` }, { db })
  // JWT itself is valid; DB session is revoked so enrichment is skipped but user is still set from JWT
  assert.equal(user.role, 'user')
  assert.equal(user.userId, 'db-user-2')
})

// ---------------------------------------------------------------------------
// 8. Legacy profile-id bearer token
// ---------------------------------------------------------------------------
test('authIdentity: legacy profile token allowed when ALLOW_LEGACY_PROFILE_TOKEN=true + non-prod', async () => {
  const profileId = '00000000-0000-0000-0000-000000000001'
  const db = makeDb(
    {},
    { [profileId]: { id: profileId, display_name: 'Test Profile' } },
  )
  const savedLegacy = process.env.ALLOW_LEGACY_PROFILE_TOKEN
  process.env.ALLOW_LEGACY_PROFILE_TOKEN = 'true'
  try {
    const user = await resolveUser(
      { authorization: `Bearer ${profileId}` },
      { db, isProd: false, adminToken: null }, // no admin token so JWT fails and we reach legacy path
    )
    assert.equal(user.role, 'user')
    assert.equal(user.profileId, profileId)
    assert.equal(user.profileName, 'Test Profile')
  } finally {
    if (savedLegacy === undefined) delete process.env.ALLOW_LEGACY_PROFILE_TOKEN
    else process.env.ALLOW_LEGACY_PROFILE_TOKEN = savedLegacy
  }
})

test('authIdentity: legacy profile token blocked when ALLOW_LEGACY_PROFILE_TOKEN=false', async () => {
  const profileId = '00000000-0000-0000-0000-000000000002'
  const db = makeDb(
    {},
    { [profileId]: { id: profileId, display_name: 'Profile 2' } },
  )
  const savedLegacy = process.env.ALLOW_LEGACY_PROFILE_TOKEN
  process.env.ALLOW_LEGACY_PROFILE_TOKEN = 'false'
  try {
    const user = await resolveUser(
      { authorization: `Bearer ${profileId}` },
      { db, isProd: false, adminToken: null },
    )
    assert.equal(user.role, 'guest')
  } finally {
    if (savedLegacy === undefined) delete process.env.ALLOW_LEGACY_PROFILE_TOKEN
    else process.env.ALLOW_LEGACY_PROFILE_TOKEN = savedLegacy
  }
})

test('authIdentity: legacy profile token blocked in prod even with ALLOW_LEGACY_PROFILE_TOKEN=true', async () => {
  const profileId = '00000000-0000-0000-0000-000000000003'
  const db = makeDb(
    {},
    { [profileId]: { id: profileId, display_name: 'Profile 3' } },
  )
  const savedLegacy = process.env.ALLOW_LEGACY_PROFILE_TOKEN
  process.env.ALLOW_LEGACY_PROFILE_TOKEN = 'true'
  try {
    const user = await resolveUser(
      { authorization: `Bearer ${profileId}` },
      { db, isProd: true, adminToken: null }, // production mode
    )
    assert.equal(user.role, 'guest')
  } finally {
    if (savedLegacy === undefined) delete process.env.ALLOW_LEGACY_PROFILE_TOKEN
    else process.env.ALLOW_LEGACY_PROFILE_TOKEN = savedLegacy
  }
})

// ---------------------------------------------------------------------------
// 9. Priority ordering
// ---------------------------------------------------------------------------
test('authIdentity: X-Admin-Token takes priority over Authorization Bearer JWT', async () => {
  const jwtToken = jwt.sign(
    { sub: 'jwt-user-1', email: 'jwtuser@example.com', roles: ['user'] },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  const user = await resolveUser({
    'x-admin-token': 'test-admin-token',
    authorization: `Bearer ${jwtToken}`,
  })
  // Admin token should win
  assert.equal(user.role, 'admin')
  assert.equal(user.userId, 'system_admin_token')
})

test('authIdentity: X-Anya-Token takes priority over Bearer JWT when both present', async () => {
  const savedKey = process.env.ANYA_API_KEY
  process.env.ANYA_API_KEY = 'anya-priority-key'
  try {
    const jwtToken = jwt.sign(
      { sub: 'jwt-user-2', roles: ['user'] },
      JWT_SECRET,
      { expiresIn: '1h' },
    )
    const user = await resolveUser({
      'x-anya-token': 'anya-priority-key',
      authorization: `Bearer ${jwtToken}`,
    })
    assert.equal(user.userId, 'system_anya_token')
  } finally {
    if (savedKey === undefined) delete process.env.ANYA_API_KEY
    else process.env.ANYA_API_KEY = savedKey
  }
})
