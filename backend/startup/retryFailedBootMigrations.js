function normalizeFailures(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

/**
 * Retry migrations that failed before the post-listen invariant sweep.
 *
 * Some data migrations intentionally fail closed until the invariant sweep has
 * repaired legacy rows. The first migration pass keeps readiness closed and
 * leaves those migrations unstamped. Once boot maintenance settles, this
 * single retry gives the canonical migration runner a chance to record the now
 * successful migration. A failed retry remains visible through /readyz.
 */
export async function retryFailedBootMigrationsAfterMaintenance({
  appLocals,
  runPendingMigrationsOnBoot,
  verifyRecovery,
  logger = console,
} = {}) {
  if (!appLocals || typeof appLocals !== 'object') {
    throw new TypeError('appLocals is required')
  }

  const priorFailures = normalizeFailures(appLocals.migrate_boot_failed_migrations)
  if (priorFailures.length === 0) {
    return { attempted: false, recovered: true, ran: 0, failed: [] }
  }
  if (typeof runPendingMigrationsOnBoot !== 'function') {
    throw new TypeError('runPendingMigrationsOnBoot is required')
  }

  logger.warn?.(
    `[migrate:boot] retrying ${priorFailures.length} failed migration(s) after boot maintenance`,
  )
  // Keep /readyz closed for the entire retry and read-back verification. The
  // migration runner can clear its durable failed list before the repaired
  // invariant has republished queue-readable task truth.
  appLocals.migrate_boot_error = 'boot_migration_retry_in_progress'

  try {
    const result = await runPendingMigrationsOnBoot({ logger })
    const failed = normalizeFailures(result?.failed)

    appLocals.migrate_boot_complete = true
    appLocals.migrate_boot_failed_migrations = failed

    if (failed.length > 0) {
      appLocals.migrate_boot_error = 'boot_migration_retry_incomplete'
      logger.error?.(
        `[migrate:boot] post-maintenance retry left ${failed.length} migration(s) unstamped`,
      )
      return {
        attempted: true,
        recovered: false,
        ran: Number.isFinite(Number(result?.ran)) ? Number(result.ran) : 0,
        failed,
      }
    }

    try {
      if (typeof verifyRecovery === 'function') {
        await verifyRecovery()
      }
    } catch (error) {
      appLocals.migrate_boot_error = 'boot_migration_retry_verification_failed'
      logger.error?.(
        `[migrate:boot] post-maintenance retry verification failed: ${error?.message || error}`,
      )
      return {
        attempted: true,
        recovered: false,
        ran: Number.isFinite(Number(result?.ran)) ? Number(result.ran) : 0,
        failed,
        error: 'boot_migration_retry_verification_failed',
      }
    }

    appLocals.migrate_boot_error = null
    logger.info?.('[migrate:boot] post-maintenance retry recovered all failed migrations')
    return {
      attempted: true,
      recovered: true,
      ran: Number.isFinite(Number(result?.ran)) ? Number(result.ran) : 0,
      failed,
    }
  } catch (error) {
    appLocals.migrate_boot_failed_migrations = priorFailures
    appLocals.migrate_boot_error = 'boot_migration_retry_failed'
    logger.error?.(
      `[migrate:boot] post-maintenance retry failed: ${error?.message || error}`,
    )
    return {
      attempted: true,
      recovered: false,
      ran: 0,
      failed: priorFailures,
      error: 'boot_migration_retry_failed',
    }
  }
}

export default retryFailedBootMigrationsAfterMaintenance
