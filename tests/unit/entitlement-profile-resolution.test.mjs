import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEntitlementProfileId } from '../../backend/middleware/entitlements.js'

function dbFor({ taskProfile = null, grantProfile = null, fail = false } = {}) {
  return {
    prepare(sql) {
      return {
        async get() {
          if (fail) throw new Error('database unavailable')
          if (sql.includes('application_tasks')) return taskProfile ? { profile_id: taskProfile } : null
          if (sql.includes('FROM grants')) return grantProfile ? { profile_id: grantProfile } : null
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
