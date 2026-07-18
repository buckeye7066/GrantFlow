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
