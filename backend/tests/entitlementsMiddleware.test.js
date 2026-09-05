/**
 * Route-wide Hamilton entitlement identity (ported from PRs #1523 / #1533).
 *
 * 1. The owner's Tasker/Gmail bridges have no GrantFlow session; their
 *    handlers authenticate with HAMILTON_SMS_INGEST_TOKEN, so the shared-secret
 *    routes must stay OUTSIDE the session entitlement middleware.
 * 2. Safety actions (revoke authorization, cancel task, disable auto-submit)
 *    remain reachable after paid access lapses.
 * 3. Saved sessions / capture requests / credentials / authorizations /
 *    attestations / live cloud-login sessions resolve to their OWNING profile
 *    before the billing decision, so one profile cannot borrow another
 *    profile's paid access by naming its record.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  bypassEntitlementWhen,
  isApplicationTaskEntitlementSafetyAction,
  isHamiltonEntitlementSafetyAction,
  isHamiltonSharedSecretRoute,
  resolveEntitlementProfileId,
} from '../middleware/entitlements.js'

function requestFor(path, rows = [], contextualProfileId = 'profile-entitled') {
  return {
    originalUrl: `/api/hamilton/automation${path}`,
    path,
    method: 'POST',
    headers: { 'x-profile-id': contextualProfileId },
    db: {
      prepare: vi.fn((sql) => ({
        get: vi.fn(async () => rows.find((row) => sql.includes(`FROM ${row.table} `))?.record || null),
      })),
    },
  }
}

describe('Hamilton shared-secret routes stay outside the session entitlement gate', () => {
  it.each(['/sms-inbox', '/inbox', '/inbox-status', '/sms-inbox/'])('exempts %s', (path) => {
    expect(isHamiltonSharedSecretRoute({ path })).toBe(true)
  })

  it('does not exempt ordinary Hamilton routes', () => {
    expect(isHamiltonSharedSecretRoute({ path: '/tasks' })).toBe(false)
    expect(isHamiltonSharedSecretRoute({ path: '/start' })).toBe(false)
    expect(isHamiltonSharedSecretRoute({ path: '/inbox/anything' })).toBe(false)
  })

  it('bypassEntitlementWhen reaches the router without touching the billing middleware', () => {
    const entitlement = vi.fn()
    const next = vi.fn()
    bypassEntitlementWhen(isHamiltonSharedSecretRoute, entitlement)({ path: '/inbox', method: 'POST' }, {}, next)
    expect(next).toHaveBeenCalledOnce()
    expect(entitlement).not.toHaveBeenCalled()

    const next2 = vi.fn()
    bypassEntitlementWhen(isHamiltonSharedSecretRoute, entitlement)({ path: '/start', method: 'POST' }, {}, next2)
    expect(entitlement).toHaveBeenCalledOnce()
    expect(next2).not.toHaveBeenCalled()
  })
})

describe('safety actions remain reachable after paid access lapses', () => {
  it('lets a user revoke an authorization and cancel a task at the Hamilton mount', () => {
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/authorizations/auth-1/revoke' })).toBe(true)
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/tasks/task-1/cancel' })).toBe(true)
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/tasks/task-1/cancel/' })).toBe(true)
  })

  it('does not exempt paid work at the Hamilton mount', () => {
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/start' })).toBe(false)
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/authorizations' })).toBe(false)
    expect(isHamiltonEntitlementSafetyAction({ method: 'GET', path: '/tasks/task-1/cancel' })).toBe(false)
    expect(isHamiltonEntitlementSafetyAction({ method: 'POST', path: '/tasks/task-1/manual-submission-receipts/r-1/revoke' })).toBe(false)
  })

  it('lets a user disable auto-submit or cancel at the application-tasks mount, but not enable', () => {
    expect(isApplicationTaskEntitlementSafetyAction({ method: 'POST', path: '/task-1/cancel' })).toBe(true)
    expect(isApplicationTaskEntitlementSafetyAction({ method: 'POST', path: '/task-1/approve-submit', body: { enable: false } })).toBe(true)
    expect(isApplicationTaskEntitlementSafetyAction({ method: 'POST', path: '/task-1/approve-submit', body: { enable: true } })).toBe(false)
    expect(isApplicationTaskEntitlementSafetyAction({ method: 'POST', path: '/task-1/approve-submit', body: {} })).toBe(false)
    expect(isApplicationTaskEntitlementSafetyAction({ method: 'POST', path: '/task-1/hamilton/start' })).toBe(false)
  })
})

describe('Hamilton owned records resolve to their owning profile before billing', () => {
  it.each([
    ['/sessions/session-1/revoke', 'hamilton_saved_sessions'],
    ['/sessions/session-1/expire', 'hamilton_saved_sessions'],
    ['/sessions/capture-requests/request-1/cancel', 'hamilton_session_capture_requests'],
    ['/sessions/capture-requests/request-1/launched', 'hamilton_session_capture_requests'],
    ['/credentials/credential-1/reveal-once', 'hamilton_portal_credentials'],
    ['/credentials/credential-1', 'hamilton_portal_credentials'],
    ['/admin/credentials/credential-1/move', 'hamilton_portal_credentials'],
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

  it('falls back to the contextual profile when the record does not exist', async () => {
    const req = requestFor('/sessions/missing/revoke', [])
    await expect(resolveEntitlementProfileId(req)).resolves.toBe('profile-entitled')
  })

  it('resolves a live cloud-login session to the profile that started it', async () => {
    const req = requestFor('/sessions/cloud-login/live-1/input', [])
    const profileId = await resolveEntitlementProfileId(req, {
      getCloudLoginMetaFn: (id) => (id === 'live-1' ? { profileId: 'live-session-owner' } : null),
    })
    expect(profileId).toBe('live-session-owner')
  })
})
