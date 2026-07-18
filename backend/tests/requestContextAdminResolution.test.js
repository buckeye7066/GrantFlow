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

function makeDb({ isAdmin }) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from users where id')) {
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
})
