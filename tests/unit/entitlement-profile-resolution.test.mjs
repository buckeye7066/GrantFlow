import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEntitlementProfileId } from '../../backend/middleware/entitlements.js'

function dbFor({ taskProfile = null, grantProfile = null, recordProfiles = {}, fail = false } = {}) {
  return {
    prepare(sql) {
      return {
        async get() {
          if (fail) throw new Error('database unavailable')
          if (sql.includes('application_tasks')) return taskProfile ? { profile_id: taskProfile } : null
          if (sql.includes('FROM grants')) return grantProfile ? { profile_id: grantProfile } : null
          for (const [table, profileId] of Object.entries(recordProfiles)) {
            if (sql.includes(`FROM ${table}`)) return profileId ? { profile_id: profileId } : null
          }
          return null
        },
      }
    },
  }
}

test('mounted application-task URL resolves the task owner before a profile header', async () => {
  const profileId = await resolveEntitlementProfileId({
    originalUrl: '/api/application-tasks/task-1/hamilton/continue',
    headers: { 'x-profile-id': 'profile-from-header' },
    db: dbFor({ taskProfile: 'profile-from-task' }),
  })
  assert.equal(profileId, 'profile-from-task')
})

for (const [name, url, table] of [
  ['saved session', '/api/hamilton/automation/sessions/session-1/revoke', 'hamilton_saved_sessions'],
  ['credential', '/api/hamilton/automation/credentials/credential-1/reveal-once', 'hamilton_portal_credentials'],
  ['authorization', '/api/hamilton/automation/authorizations/auth-1/revoke', 'hamilton_authorizations'],
  ['capture request', '/api/hamilton/automation/sessions/capture-requests/request-1/cancel', 'hamilton_session_capture_requests'],
  ['attestation', '/api/hamilton/automation/attestations/attestation-1/revoke', 'hamilton_attestation_authorizations'],
]) {
  test(`${name} owner wins over the active-profile header`, async () => {
    const profileId = await resolveEntitlementProfileId({
      originalUrl: url,
      headers: { 'x-profile-id': 'paid-profile' },
      db: dbFor({ recordProfiles: { [table]: 'record-owner-profile' } }),
    })
    assert.equal(profileId, 'record-owner-profile')
  })
}

test('a task or grant cannot borrow entitlement from a different explicit profile', async () => {
  await assert.rejects(
    resolveEntitlementProfileId({
      originalUrl: '/api/hamilton/automation/tasks/task-1/retry',
      body: { profile_id: 'paid-profile' },
      db: dbFor({ taskProfile: 'unpaid-profile' }),
    }),
    { code: 'entitlement_profile_mismatch', status: 409 },
  )
})

test('an indirect lookup failure is unavailable, never replaced by a header profile', async () => {
  await assert.rejects(
    resolveEntitlementProfileId({
      originalUrl: '/api/hamilton/automation/tasks/task-1/retry',
      headers: { 'x-profile-id': 'paid-profile' },
      db: dbFor({ fail: true }),
    }),
    /database unavailable/,
  )
})

test('a live cloud-login session resolves its owning profile before billing', async () => {
  const profileId = await resolveEntitlementProfileId({
    originalUrl: '/api/hamilton/automation/sessions/cloud-login/live-1/input',
    headers: { 'x-profile-id': 'paid-profile' },
    db: dbFor(),
  }, {
    getCloudLoginMetaFn: (id) => id === 'live-1' ? { profileId: 'live-session-owner' } : null,
  })
  assert.equal(profileId, 'live-session-owner')
})
