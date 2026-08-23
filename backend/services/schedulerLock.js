import crypto from 'node:crypto'

import { withLock, renewLock } from './agentControl/agentControlStore.js'
import { captureException } from '../utils/observability.js'

const DEFAULT_TTL_MS = 30 * 60 * 1000
// A heartbeat renews the lease every TTL/3 so a live holder always stays ahead
// of its own (short) deadline, with two misses of slack before it lapses.
const HEARTBEAT_DIVISOR = 3
const MIN_HEARTBEAT_MS = 30_000

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
  heartbeat = false,
} = {}, fn) {
  if (typeof fn !== 'function') throw new Error('runWithSchedulerLock: fn required')
  if (!db || !lockName) return await fn()

  const fullLockName = `scheduler:${lockName}`

  try {
    return await withLock(
      db,
      {
        lockName: fullLockName,
        controlRunId: lockRunId(lockName),
        acquiredBy,
        ttlMs,
        retries: 0,
      },
      // When heartbeat is enabled the lock can carry a SHORT ttlMs: a live
      // holder renews its lease on a timer while the critical section runs, so
      // a run that outlives ttlMs keeps the lock — while a deploy-killed holder
      // stops renewing and the lock lapses within one ttlMs instead of wedging
      // the scheduler for the full (previously multi-hour) window. Renewal is
      // fenced by the owner token, so it can only push out THIS lease.
      heartbeat
        ? async (lease) => {
            let handle = null
            if (lease?.ownerToken) {
              const period = Math.max(MIN_HEARTBEAT_MS, Math.floor((Number(ttlMs) || DEFAULT_TTL_MS) / HEARTBEAT_DIVISOR))
              handle = setInterval(() => {
                renewLock(db, { lockName: fullLockName, ownerToken: lease.ownerToken, ttlMs }).catch((err) =>
                  logger?.warn?.('[scheduler-lock] heartbeat renew failed', { lockName, error: err?.message || err }),
                )
              }, period)
              if (typeof handle?.unref === 'function') handle.unref()
            }
            try {
              return await fn(lease)
            } finally {
              if (handle) clearInterval(handle)
            }
          }
        : fn,
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
