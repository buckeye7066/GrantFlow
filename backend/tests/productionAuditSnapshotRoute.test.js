import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

describe('admin production audit snapshot route', () => {
  let app

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
  }, 60_000)

  it('rejects unauthenticated callers at the centralized /api/admin gate', async () => {
    const response = await request(app)
      .get('/api/admin/queue/production-audit/snapshot?profiles=route-test-profile')

    expect(response.status).toBe(401)
  })

  it('rejects malformed and over-broad profile scopes without echoing them', async () => {
    const malformed = await request(app)
      .get('/api/admin/queue/production-audit/snapshot?profiles=bad%20profile')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({
      ok: false,
      error: 'AUDIT_PROFILE_ID_INVALID',
      details_redacted: true,
    })
    expect(JSON.stringify(malformed.body)).not.toContain('bad profile')

    const tooMany = Array.from({ length: 11 }, (_, index) => `p${index}`).join(',')
    const broad = await request(app)
      .get(`/api/admin/queue/production-audit/snapshot?profiles=${tooMany}`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(broad.status).toBe(400)
    expect(broad.body.error).toBe('AUDIT_PROFILE_LIMIT_EXCEEDED')
  })

  it('returns a bounded, no-store, sanitized snapshot for an admin', async () => {
    const response = await request(app)
      .get('/api/admin/queue/production-audit/snapshot?profiles=route-test-profile&match_limit=5')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.body).toMatchObject({
      ok: true,
      contract: 'production-audit-snapshot-v1',
      safety: {
        admin_only: true,
        query_model: 'hardcoded_selects_only',
        sensitive_tables_read: false,
        match_limit_per_profile: 5,
      },
      scope: {
        requested_profile_ids: ['route-test-profile'],
        missing_profile_ids: ['route-test-profile'],
      },
    })
    expect(response.body.hamilton.cross_scope_task_rows).toBe(0)
  })
})
