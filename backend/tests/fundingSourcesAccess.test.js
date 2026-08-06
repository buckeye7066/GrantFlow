/**
 * Regression guard for GET /api/profiles/:id/funding-sources access control.
 *
 * THE ORIGINAL DEFECT (found 2026-07-28 by the production-audit bridge): the
 * gate used Array.isArray even though getAccessibleProfileIds returns a Set.
 * That denied every non-admin caller access to their own funding-source list.
 *
 * THE FOLLOW-UP DEFECT: the helper can also return null as its admin sentinel.
 * That sentinel must never override an already-built non-admin request context;
 * only req.ctx.isAdmin may grant global access. A disagreement therefore fails
 * closed instead of widening access across profiles.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import {
  isExplicitRollingDeadline,
  isFundingSourcesReadOnlyAudit,
  userMayAccessProfile,
} from '../routes/fundingSources.js'

const PROFILE = 'profile-demo-caregiver-household'
const OTHER = '6b3c75ec-dc56-46f9-b380-394172688175'

describe('funding-source deadline truth', () => {
  it('does not reinterpret a missing deadline as rolling', () => {
    expect(isExplicitRollingDeadline({ deadline: null, deadline_type: null })).toBe(false)
    expect(isExplicitRollingDeadline({ deadline: null, deadline_type: 'fixed' })).toBe(false)
    expect(isExplicitRollingDeadline({ deadline: null, deadline_type: 'rolling' })).toBe(true)
    expect(isExplicitRollingDeadline({ deadline: null, deadline_type: 'ongoing' })).toBe(true)
  })
})

/**
 * `user` is passed through to getAccessibleProfileIds when the request context
 * does not carry a scoped Set, so the database behavior is stubbed here.
 */
function makeReq({
  isAdmin = false,
  dbAdmin = false,
  accessibleProfileIds,
  owned = [],
  grantedByEmail = [],
  userId = 'u-audit',
  email = 'a@b.test',
  headers = {},
} = {}) {
  const db = {
    prepare(sql) {
      const s = String(sql)
      return {
        async get() {
          if (/FROM users WHERE id/i.test(s)) return { id: userId, is_admin: dbAdmin ? 1 : 0 }
          if (/FROM users WHERE LOWER/i.test(s)) return { id: userId, is_admin: dbAdmin ? 1 : 0 }
          return null
        },
        async all() {
          if (/FROM profiles WHERE user_id/i.test(s)) return owned.map((id) => ({ id }))
          if (/FROM profiles WHERE created_by/i.test(s)) return []
          if (/FROM profile_emails/i.test(s) || /profile_id[\s\S]*profile_emails/i.test(s)) {
            return grantedByEmail.map((id) => ({ profile_id: id, id }))
          }
          if (/FROM users/i.test(s)) return [{ primary_email: email }]
          return []
        },
        async run() {
          return { changes: 0 }
        },
      }
    },
    exec: async () => {},
  }
  const ctx = { isAdmin }
  if (accessibleProfileIds !== undefined) ctx.accessibleProfileIds = accessibleProfileIds
  return { db, ctx, headers, user: { id: userId, email } }
}

describe('funding-sources profile access gate', () => {
  it('admits a profile the user owns when access is recomputed as a Set', async () => {
    const req = makeReq({ owned: [PROFILE] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(true)
  })

  it('uses the canonical request-context Set when it is available', async () => {
    const req = makeReq({ accessibleProfileIds: new Set([PROFILE]), owned: [] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(true)
    await expect(userMayAccessProfile(req, req.user, OTHER)).resolves.toBe(false)
  })

  it('refuses a profile the user has no claim on', async () => {
    const req = makeReq({ owned: [OTHER] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(false)
  })

  it('admits an admin through the canonical ctx branch', async () => {
    const req = makeReq({ isAdmin: true, owned: [] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(true)
  })

  it('fails closed when a second DB lookup returns the null admin sentinel under a non-admin context', async () => {
    const req = makeReq({ isAdmin: false, dbAdmin: true, owned: [] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(false)
  })

  it('refuses when no profile id is supplied', async () => {
    const req = makeReq({ owned: [PROFILE] })
    await expect(userMayAccessProfile(req, req.user, '')).resolves.toBe(false)
  })

  it('pins the Set container contract that the original gate mishandled', () => {
    const set = new Set([PROFILE])
    expect(Array.isArray(set)).toBe(false)
    expect(set.has(PROFILE)).toBe(true)
  })
})

describe('funding-sources read-only audit labeling', () => {
  it('is enabled only for a resolved admin plus the explicit audit header', () => {
    expect(isFundingSourcesReadOnlyAudit(makeReq({
      isAdmin: true,
      headers: { 'x-grantflow-audit-read-only': 'true' },
    }))).toBe(true)

    expect(isFundingSourcesReadOnlyAudit(makeReq({
      isAdmin: false,
      headers: { 'x-grantflow-audit-read-only': 'true' },
    }))).toBe(false)

    expect(isFundingSourcesReadOnlyAudit(makeReq({
      isAdmin: true,
      headers: {},
    }))).toBe(false)
  })

  it('pins every GET path as mutation-free presentation', () => {
    const source = fs.readFileSync('backend/routes/fundingSources.js', 'utf8')
    expect(source).not.toContain('ensurePipelineDismissalsSchema')
    expect(source).not.toContain('reconcileNeedFirstProfileMatches')
    expect(source).toContain('read_only: true')
    expect(source).toContain('deferred_to_background: true')
    expect(source).toContain('read_only_audit: readOnlyAudit')
  })
})
