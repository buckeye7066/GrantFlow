/**
 * SECURITY REGRESSION (raw JWT admin role bypassing the SQL tenant guard).
 *
 * profileContextMiddleware stamped actorRole from req.user.role as a fallback, so
 * a demoted admin (req.ctx.isAdmin=false) whose JWT still says role:'admin' got
 * actorRole:'admin' in the AsyncLocalStorage context — and scopedQuery SKIPS
 * profile-scope enforcement for ADMIN_ROLES. actorRole must derive from
 * req.ctx.isAdmin ONLY (DB-backed, fail-closed).
 */

import { describe, expect, it } from 'vitest'
import { profileContextMiddleware, getProfileContext } from '../middleware/profileContext.js'

function runWith(req) {
  let captured = null
  const mw = profileContextMiddleware()
  mw(req, {}, () => { captured = getProfileContext() })
  return captured
}

describe('profileContext actorRole is DB-backed (req.ctx.isAdmin) only', () => {
  it('a demoted admin (ctx.isAdmin=false) with a role:admin JWT gets actorRole=user (no scopedQuery bypass)', () => {
    const ctx = runWith({
      method: 'GET',
      originalUrl: '/api/matching/profile/victim/grants',
      ctx: { isAdmin: false, userId: 'demoted' },
      user: { role: 'admin', roles: ['admin'], is_admin: true, userId: 'demoted' },
    })
    expect(ctx.actorRole).toBe('user')
  })

  it('a genuine admin context (ctx.isAdmin=true) gets actorRole=admin', () => {
    const ctx = runWith({
      method: 'GET',
      originalUrl: '/api/admin/x',
      ctx: { isAdmin: true, userId: 'boss' },
      user: { role: 'user', userId: 'boss' },
    })
    expect(ctx.actorRole).toBe('admin')
  })

  it('a plain user gets actorRole=user', () => {
    const ctx = runWith({
      method: 'GET',
      originalUrl: '/api/x',
      ctx: { isAdmin: false, userId: 'u1' },
      user: { role: 'user', userId: 'u1' },
    })
    expect(ctx.actorRole).toBe('user')
  })
})
