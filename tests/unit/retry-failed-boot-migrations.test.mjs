import assert from 'node:assert/strict'
import test from 'node:test'

import { retryFailedBootMigrationsAfterMaintenance } from '../../backend/startup/retryFailedBootMigrations.js'

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

test('post-maintenance migration retry is skipped when the first pass was clean', async () => {
  const appLocals = { migrate_boot_failed_migrations: [] }
  let calls = 0
  const result = await retryFailedBootMigrationsAfterMaintenance({
    appLocals,
    runPendingMigrationsOnBoot: async () => {
      calls += 1
      return { ran: 0, failed: [] }
    },
    logger: quietLogger(),
  })

  assert.equal(calls, 0)
  assert.deepEqual(result, {
    attempted: false,
    recovered: true,
    ran: 0,
    failed: [],
  })
})

test('post-maintenance migration retry clears readiness failures after recovery', async () => {
  const appLocals = {
    migrate_boot_complete: true,
    migrate_boot_error: null,
    migrate_boot_failed_migrations: ['1001_live_hamilton_task_truth.mjs'],
  }
  let verificationCalls = 0
  const result = await retryFailedBootMigrationsAfterMaintenance({
    appLocals,
    runPendingMigrationsOnBoot: async () => {
      assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_in_progress')
      return { ran: 1, failed: [] }
    },
    verifyRecovery: async () => {
      verificationCalls += 1
      assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_in_progress')
      assert.deepEqual(appLocals.migrate_boot_failed_migrations, [])
    },
    logger: quietLogger(),
  })

  assert.deepEqual(result, {
    attempted: true,
    recovered: true,
    ran: 1,
    failed: [],
  })
  assert.equal(verificationCalls, 1)
  assert.equal(appLocals.migrate_boot_complete, true)
  assert.equal(appLocals.migrate_boot_error, null)
  assert.deepEqual(appLocals.migrate_boot_failed_migrations, [])
})

test('post-maintenance migration retry keeps readiness closed when a migration still fails', async () => {
  const appLocals = {
    migrate_boot_complete: true,
    migrate_boot_error: null,
    migrate_boot_failed_migrations: ['1001_live_hamilton_task_truth.mjs'],
  }
  let verificationCalls = 0
  const result = await retryFailedBootMigrationsAfterMaintenance({
    appLocals,
    runPendingMigrationsOnBoot: async () => ({
      ran: 0,
      failed: ['1001_live_hamilton_task_truth.mjs'],
    }),
    verifyRecovery: async () => {
      verificationCalls += 1
      assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_in_progress')
      assert.deepEqual(appLocals.migrate_boot_failed_migrations, [
        '1001_live_hamilton_task_truth.mjs',
      ])
    },
    logger: quietLogger(),
  })

  assert.equal(result.recovered, false)
  assert.equal(verificationCalls, 1)
  assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_incomplete')
  assert.deepEqual(appLocals.migrate_boot_failed_migrations, [
    '1001_live_hamilton_task_truth.mjs',
  ])
})

test('post-maintenance migration retry keeps readiness closed when recovery verification fails', async () => {
  const appLocals = {
    migrate_boot_complete: true,
    migrate_boot_error: null,
    migrate_boot_failed_migrations: ['1001_live_hamilton_task_truth.mjs'],
  }
  const result = await retryFailedBootMigrationsAfterMaintenance({
    appLocals,
    runPendingMigrationsOnBoot: async () => ({ ran: 1, failed: [] }),
    verifyRecovery: async () => {
      throw new Error('task truth remained migration_reconciled')
    },
    logger: quietLogger(),
  })

  assert.deepEqual(result, {
    attempted: true,
    recovered: false,
    ran: 1,
    failed: [],
    error: 'boot_migration_retry_verification_failed',
  })
  assert.equal(appLocals.migrate_boot_complete, true)
  assert.equal(
    appLocals.migrate_boot_error,
    'boot_migration_retry_verification_failed',
  )
  assert.deepEqual(appLocals.migrate_boot_failed_migrations, [])
})

test('post-maintenance migration retry preserves the failed set when the runner throws', async () => {
  const appLocals = {
    migrate_boot_complete: true,
    migrate_boot_error: null,
    migrate_boot_failed_migrations: ['1001_live_hamilton_task_truth.mjs'],
  }
  let verificationCalls = 0
  const result = await retryFailedBootMigrationsAfterMaintenance({
    appLocals,
    runPendingMigrationsOnBoot: async () => {
      throw new Error('database unavailable')
    },
    verifyRecovery: async () => {
      verificationCalls += 1
      assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_in_progress')
    },
    logger: quietLogger(),
  })

  assert.equal(result.recovered, false)
  assert.equal(verificationCalls, 1)
  assert.equal(result.error, 'boot_migration_retry_failed')
  assert.equal(appLocals.migrate_boot_error, 'boot_migration_retry_failed')
  assert.deepEqual(appLocals.migrate_boot_failed_migrations, [
    '1001_live_hamilton_task_truth.mjs',
  ])
})
