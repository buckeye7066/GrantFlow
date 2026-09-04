import { describe, expect, it, vi } from 'vitest'

import {
  isHamiltonSharedSecretRoute,
  resolveEntitlementProfileId,
} from '../middleware/entitlements.js'

function requestFor(path, rows, contextualProfileId = 'profile-entitled') {
  return {
    originalUrl: `/api/hamilton/automation${path}`,
    path,
    headers: { 'x-profile-id': contextualProfileId },
    db: {
      prepare: vi.fn((sql) => ({
        get: vi.fn(async () => rows.find((row) => sql.includes(row.table))?.record || null),
      })),
    },
  }
}

describe('Hamilton route-wide entitlement identity', () => {
  it.each(['/sms-inbox', '/inbox', '/inbox-status', '/sms-inbox/'])(
    'leaves shared-secret route %s outside the session entitlement gate',
    (path) => expect(isHamiltonSharedSecretRoute({ path })).toBe(true),
  )

  it('does not exempt ordinary Hamilton routes', () => {
    expect(isHamiltonSharedSecretRoute({ path: '/tasks' })).toBe(false)
  })

  it.each([
    ['/sessions/session-1/revoke', 'hamilton_saved_sessions'],
    ['/sessions/capture-requests/request-1/cancel', 'hamilton_session_capture_requests'],
    ['/credentials/credential-1/reveal-once', 'hamilton_portal_credentials'],
    ['/authorizations/auth-1/revoke', 'hamilton_authorizations'],
    ['/attestations/attest-1/revoke', 'hamilton_attestation_authorizations'],
  ])('resolves %s from its resource owner instead of the active profile', async (path, table) => {
    const req = requestFor(path, [{ table, record: { profile_id: 'profile-resource-owner' } }])
    await expect(resolveEntitlementProfileId(req)).resolves.toBe('profile-resource-owner')
  })

  it('rejects an explicit profile that conflicts with the resource owner', async () => {
    const req = requestFor('/credentials/credential-1/reveal-once', [
      { table: 'hamilton_portal_credentials', record: { profile_id: 'profile-resource-owner' } },
    ])
    req.body = { profileId: 'profile-entitled' }
    await expect(resolveEntitlementProfileId(req)).rejects.toMatchObject({
      code: 'entitlement_profile_mismatch',
      status: 409,
    })
  })
})
