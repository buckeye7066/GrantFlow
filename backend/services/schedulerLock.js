import crypto from 'node:crypto'

import { withLock } from './agentControl/agentControlStore.js'
import { captureException } from '../utils/observability.js'

const DEFAULT_TTL_MS = 30 * 60 * 1000

function lockRunId(lockName) {
  const safeName = String(lockName || 'unknown').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 80)
  return `scheduler:${safeName}:${Date.now()}:${crypto.randomUUID()}`
}

export function reportBackgroundError(error, context = {}) {
  captureException(error, {
    source: 'background_scheduler',
    ...context,
  })
  return error
}

export async function runWithSchedulerLock(db, {
  lockName,
  ttlMs = DEFAULT_TTL_MS,
  logger = console,
  acquiredBy = 'scheduler',
} = {}, fn) {
  if (typeof fn !== 'function') throw new Error('runWithSchedulerLock: fn required')
  if (!db || !lockName) return await fn()

  try {
    return await withLock(
      db,
      {
        lockName: `scheduler:${lockName}`,
        controlRunId: lockRunId(lockName),
        acquiredBy,
        ttlMs,
        retries: 0,
      },
      fn,
    )
  } catch (error) {
    if (error?.code === 'LOCK_NOT_ACQUIRED') {
      logger?.info?.('[scheduler-lock] skipped; lock held', {
        lockName,
        heldBy: error?.lease?.heldBy || null,
        expiresAt: error?.lease?.expiresAt || null,
      })
      return { skipped: true, reason: 'lock_held', lockName }
    }
    reportBackgroundError(error, { lockName })
    throw error
  }
}

export default {
  reportBackgroundError,
  runWithSchedulerLock,
}
