/**
 * PROD 500 REGRESSION (observed live 2026-08-16, request ids a5f76433/434fd9b2).
 *
 * ensureGrantAccess() opens with `SELECT * FROM grants WHERE id = ?` — a
 * pre-authorization lookup that must span profiles because the authorization
 * decision is made FROM the row it returns. Under a NON-ADMIN tenant claim the
 * profile-scope guard (backend/db/scopedQuery.js) rejects unscoped `grants`
 * reads, so every non-admin grant-by-id route (GET one, PUT update, PATCH
 * /:id/status, DELETE) died with PROFILE_SCOPE_VIOLATION in production.
 *
 * The fix wraps ONLY that lookup in withProfileScope({ bypass: true }) — the
 * sanctioned pattern for access-check reads (see routes/grants.js
 * runLegacyProfilelessGrantQuery). These tests pin both halves:
 *   1. a non-admin tenant can reach a grant their profile owns (no throw), and
 *   2. the bypass does NOT weaken authorization — inaccessible grants still 403.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { runProfileContext, assertProfileScopedSql } = await import('../db/scopedQuery.js')
const { ensureGrantAccess } = await import('../utils/accessControl.js')

const TENANT_CTX = {
  profileId: 'profile-tenant-1',
  userId: 'user-tenant-1',
  actorRole: 'enduser',
  route: 'PATCH /api/grants/:id/status',
}

function makeGuardedDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, organization_id TEXT, title TEXT);
    INSERT INTO grants (id, profile_id, organization_id, title) VALUES
      ('g-owned', 'profile-tenant-1', NULL, 'Owned grant'),
      ('g-foreign', 'profile-other', NULL, 'Someone else''s grant');
  `)
  // Minimal mirror of backend/db/index.js: every prepare() runs the profile
  // scope assertion, so the guard is genuinely exercised by these tests.
  return {
    prepare(sql) {
      assertProfileScopedSql(sql)
      return raw.prepare(sql)
    },
  }
}

function makeRes() {
  const res = { statusCode: 200, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (payload) => { res.body = payload; return res }
  return res
}

function makeReq(db) {
  return {
    db,
    user: { id: 'user-tenant-1', role: 'user' },
    ctx: {
      isAdmin: false,
      accessibleProfileIds: new Set(['profile-tenant-1']),
      accessibleOrgIds: new Set(),
    },
  }
}

describe('ensureGrantAccess under a non-admin tenant scope claim', () => {
  let db
  beforeEach(() => { db = makeGuardedDb() })

  it('REGRESSION: reaches an owned grant instead of dying with PROFILE_SCOPE_VIOLATION', async () => {
    const res = makeRes()
    const grant = await runProfileContext(TENANT_CTX, () =>
      ensureGrantAccess(makeReq(db), res, 'g-owned'),
    )
    expect(grant?.id).toBe('g-owned')
    expect(res.statusCode).toBe(200)
  })

  it('the scope bypass does not weaken authorization: a foreign grant still 403s', async () => {
    const res = makeRes()
    const grant = await runProfileContext(TENANT_CTX, () =>
      ensureGrantAccess(makeReq(db), res, 'g-foreign'),
    )
    expect(grant).toBe(null)
    expect(res.statusCode).toBe(403)
  })

  it('a missing grant still 404s', async () => {
    const res = makeRes()
    const grant = await runProfileContext(TENANT_CTX, () =>
      ensureGrantAccess(makeReq(db), res, 'g-nope'),
    )
    expect(grant).toBe(null)
    expect(res.statusCode).toBe(404)
  })
})
