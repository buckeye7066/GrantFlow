/**
 * SECURITY REGRESSION (stale-JWT admin).
 *
 * Every admin authorization decision in the route layer was migrated from the
 * token-claim isAdminUser(user) to the DB-backed req.ctx.isAdmin. This test
 * pins the linchpin: buildRequestContext resolves admin status from
 * users.is_admin, NOT from the token's role/is_admin claim. A user holding an
 * unexpired role:'admin' JWT but demoted in the DB must get ctx.isAdmin=false
 * and a SCOPED accessible-profile set (not the admin "all" sentinel).
 */

import { describe, expect, it } from 'vitest'
import { buildRequestContext } from '../middleware/requestContext.js'

function emailStubDb(usersRow) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from users where id')) return { get: () => usersRow }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
}

describe('buildRequestContext ctx.email is DB-hydrated (token email never becomes access identity)', () => {
  it('ctx.email = users.primary_email (DB); ctx.tokenEmail = the raw token email', async () => {
    const ctx = await buildRequestContext(
      emailStubDb({ is_admin: 0, primary_email: 'real@db.example' }),
      { role: 'user', userId: 'u1', email: 'forged@token.example' },
    )
    expect(ctx.email).toBe('real@db.example')
    expect(ctx.tokenEmail).toBe('forged@token.example')
  })

  it('no users row -> ctx.email is null even though the token supplies an email (fail closed)', async () => {
    const ctx = await buildRequestContext(
      emailStubDb(null),
      { role: 'user', userId: 'u1', email: 'forged@token.example' },
    )
    expect(ctx.email).toBeNull()
    expect(ctx.tokenEmail).toBe('forged@token.example')
  })
})

function makeDb({ isAdmin, failUsersLookup = false }) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from users where id')) {
        if (failUsersLookup) {
          return { get: () => { throw new Error('simulated context DB failure') } }
        }
        return { get: () => ({ is_admin: isAdmin ? 1 : 0, primary_email: null }) }
      }
      if (norm.includes('from profiles where user_id')) {
        return { all: () => [{ id: 'pA' }] }
      }
      if (norm.includes('from profiles where created_by')) {
        return { all: () => [] }
      }
      if (norm.includes('distinct organization_id from profiles')) {
        return { all: () => [{ organization_id: 'orgA' }] }
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
}

describe('buildRequestContext DB-backed admin resolution', () => {
  it('a demoted user with a role:admin JWT resolves to NON-admin, scoped', async () => {
    const user = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'demoted' }
    const ctx = await buildRequestContext(makeDb({ isAdmin: false }), user)
    expect(ctx.isAdmin).toBe(false)
    // Scoped set, NOT the admin "all" (null) sentinel.
    expect(ctx.accessibleProfileIds instanceof Set).toBe(true)
    expect(ctx.accessibleProfileIds.has('pA')).toBe(true)
  })

  it('a genuine DB admin resolves to admin with the all-access sentinel', async () => {
    const user = { userId: 'boss' }
    const ctx = await buildRequestContext(makeDb({ isAdmin: true }), user)
    expect(ctx.isAdmin).toBe(true)
    expect(ctx.accessibleProfileIds).toBeNull()
  })

  it('FAILS CLOSED: a demoted role:admin JWT with a context-DB failure is NOT admin', async () => {
    const user = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'demoted' }
    const ctx = await buildRequestContext(makeDb({ isAdmin: false, failUsersLookup: true }), user)
    expect(ctx.isAdmin).toBe(false)
  })

  it('a validated synthetic service token (serviceToken provenance) stays admin even when the DB lookup fails', async () => {
    // ADMIN_TOKEN flow: safeTokenEqual branch set serviceToken:true + synthetic id.
    const user = { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' }
    const ctx = await buildRequestContext(makeDb({ isAdmin: false, failUsersLookup: true }), user)
    expect(ctx.isAdmin).toBe(true)
  })

  it('a raw role:admin JWT whose userId is NOT a synthetic service id never gets admin from the token', async () => {
    // No users row at all (get -> null) and not the configured admin email.
    const db = {
      dialect: 'sqlite',
      prepare() { return { get: () => null, all: () => [], run: () => ({ changes: 0 }) } },
    }
    const user = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'attacker-novel-id' }
    const ctx = await buildRequestContext(db, user)
    expect(ctx.isAdmin).toBe(false)
  })

  it('a JWT whose sub COLLIDES with a synthetic id but lacks service-token provenance is NOT a service admin', async () => {
    // Attack: sign a JWT { sub:'system_admin_token', roles:['admin'] }. The JWT
    // branch builds userId:'system_admin_token', is_admin:true — but NO
    // serviceToken flag (a JWT payload can't set it). It must fall through to the
    // DB lookup (no is_admin row here => null) and resolve NON-admin.
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from users where id')) return { get: () => null }
        return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
      },
    }
    const jwtUser = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'system_admin_token' }
    const ctx = await buildRequestContext(db, jwtUser)
    expect(ctx.isAdmin).toBe(false)
  })

  it('a JWT carrying the CONFIGURED admin email but no is_admin DB row is NOT admin', async () => {
    // The token supplies email=buckeye7066@gmail.com (the configured admin), but
    // there is no users row. The configured-admin-email elevation must be honored
    // ONLY from a trusted DB email, never a token claim -> non-admin.
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from users where id')) return { get: () => null }
        return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
      },
    }
    const user = { role: 'user', userId: 'attacker', email: 'buckeye7066@gmail.com' }
    const ctx = await buildRequestContext(db, user)
    expect(ctx.isAdmin).toBe(false)
  })

  it('a real DB user whose STORED email is the configured admin resolves to admin', async () => {
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from users where id')) {
          // is_admin flag not yet set, but the trusted stored email is configured admin.
          return { get: () => ({ is_admin: 0, primary_email: 'buckeye7066@gmail.com' }) }
        }
        return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
      },
    }
    const user = { role: 'user', userId: 'realowner' }
    const ctx = await buildRequestContext(db, user)
    expect(ctx.isAdmin).toBe(true)
  })

  it('FAIL-CLOSED never carries the null all-access sentinel (accessible sets coerced to empty)', async () => {
    // Repro of the coordinator scenario: the context admin lookup (SELECT
    // is_admin, primary_email ...) TIMES OUT -> isAdmin=false (fail closed), but
    // getAccessibleProfileIds' own admin check (SELECT is_admin ...) SUCCEEDS and
    // says admin -> returns null. A non-admin context must NOT carry null.
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from users where id')) {
          if (norm.includes('primary_email')) {
            // requestContext's admin lookup -> fail (fail closed).
            return { get: () => { throw new Error('statement timeout') } }
          }
          // isAdminUserWithDb's lookup (inside the helpers) -> succeeds as admin,
          // making getAccessibleProfileIds/OrgIds return the null sentinel.
          return { get: () => ({ is_admin: 1 }) }
        }
        return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
      },
    }
    const user = { role: 'admin', is_admin: true, roles: ['admin'], userId: 'demoted' }
    const ctx = await buildRequestContext(db, user)
    expect(ctx.isAdmin).toBe(false)
    expect(ctx.accessibleProfileIds instanceof Set).toBe(true)
    expect(ctx.accessibleProfileIds.size).toBe(0)
    expect(ctx.accessibleOrgIds instanceof Set).toBe(true)
    expect(ctx.accessibleOrgIds.size).toBe(0)
  })
})

describe('buildRequestContext ctx.identityResolved (trusted-identity flag for ownership fallbacks)', () => {
  function usersRowStub(row) {
    return {
      dialect: 'sqlite',
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from users where id')) return { get: () => row }
        return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
      },
    }
  }

  it('true for a real user (users row present)', async () => {
    const ctx = await buildRequestContext(usersRowStub({ is_admin: 0, primary_email: 'u@x.example' }), { role: 'user', userId: 'u1' })
    expect(ctx.identityResolved).toBe(true)
  })

  it('FALSE for a deleted-user JWT (no users row) — ownership fallbacks must not trust ctx.userId', async () => {
    const ctx = await buildRequestContext(usersRowStub(null), { role: 'user', userId: 'deleted-user' })
    expect(ctx.identityResolved).toBe(false)
    expect(ctx.userId).toBe('deleted-user') // still populated, but NOT trusted
    expect(ctx.accessibleProfileIds instanceof Set && ctx.accessibleProfileIds.size === 0).toBe(true)
  })

  it('true for a validated synthetic service token', async () => {
    const ctx = await buildRequestContext(usersRowStub(null), { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' })
    expect(ctx.identityResolved).toBe(true)
  })

  it('true for a DB-verified legacy profile token (profileTokenAuth)', async () => {
    const ctx = await buildRequestContext(usersRowStub(null), { role: 'user', userId: 'p1', profileId: 'p1', profileTokenAuth: true })
    expect(ctx.identityResolved).toBe(true)
  })
})
