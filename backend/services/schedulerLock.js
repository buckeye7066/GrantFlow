import crypto from 'node:crypto'

import { withLock, renewLock } from './agentControl/agentControlStore.js'
import { captureException } from '../utils/observability.js'

const DEFAULT_TTL_MS = 30 * 60 * 1000
// A heartbeat renews the lease every TTL/3 so a live holder always stays ahead
// of its own (short) deadline, with two misses of slack before it lapses.
const HEARTBEAT_DIVISOR = 3
const MIN_HEARTBEAT_MS = 30_000

// Distributed leases protect separate replicas. This process-local fence closes
// the remaining gap when one live task outlives its lease: a later interval tick
// in the same Node process must still not start a second copy while the first
// callback is executing. The entry is removed only after fn() has fully settled.
const localInFlightLocks = new Set()

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
  // Scheduler work is single-flight for its entire callback lifetime, not just
  // for the first TTL window. Heartbeat therefore defaults ON. A dead replica
  // stops renewing and still self-recovers after ttlMs; callers may explicitly
  // opt out only when a fixed, non-renewing lease is intentional.
  heartbeat = true,
} = {}, fn) {
  if (typeof fn !== 'function') throw new Error('runWithSchedulerLock: fn required')
  if (!lockName) return await fn()

  const fullLockName = `scheduler:${lockName}`
  if (localInFlightLocks.has(fullLockName)) {
    logger?.info?.('[scheduler-lock] skipped; local run still active', { lockName })
    return { skipped: true, reason: 'already_running', lockName }
  }

  localInFlightLocks.add(fullLockName)
  try {
    // Some unit/local call sites intentionally run without a database. Keep the
    // same availability behavior, but retain the local single-flight fence.
    if (!db) return await fn()

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
              let renewalInFlight = null
              let leaseLostError = null
              const abortController = new AbortController()
              const leaseContext = { ...lease, signal: abortController.signal }
              if (lease?.ownerToken) {
                const period = Math.max(MIN_HEARTBEAT_MS, Math.floor((Number(ttlMs) || DEFAULT_TTL_MS) / HEARTBEAT_DIVISOR))
                handle = setInterval(() => {
                  // Do not overlap renewals on a slow database. A rejected call is
                  // an operational warning (the next heartbeat may recover), but
                  // a resolved `false` is the lock store's fenced proof that this
                  // owner no longer holds the lease and must never be ignored.
                  if (renewalInFlight || leaseLostError) return
                  const attempt = Promise.resolve()
                    .then(() => renewLock(db, { lockName: fullLockName, ownerToken: lease.ownerToken, ttlMs }))
                    .then((renewed) => {
                      if (renewed !== false) return
                      leaseLostError = new Error(`Scheduler lock lease lost during heartbeat: ${fullLockName}`)
                      leaseLostError.code = 'LOCK_LEASE_LOST'
                      leaseLostError.lockName = fullLockName
                      abortController.abort(leaseLostError)
                      logger?.error?.('[scheduler-lock] heartbeat lost lease', { lockName })
                    })
                    .catch((err) => {
                      logger?.warn?.('[scheduler-lock] heartbeat renew failed', { lockName, error: err?.message || err })
                    })
                    .finally(() => {
                      if (renewalInFlight === attempt) renewalInFlight = null
                    })
                  renewalInFlight = attempt
                }, period)
                if (typeof handle?.unref === 'function') handle.unref()
              }
              try {
                const result = await fn(leaseContext)
                // A tick may already be in flight when the critical section
                // finishes. Await it so a definitive fenced `false` cannot race
                // with a successful scheduler result.
                if (renewalInFlight) await renewalInFlight
                if (leaseLostError) throw leaseLostError
                return result
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
  } finally {
    localInFlightLocks.delete(fullLockName)
  }
}

export default {
  reportBackgroundError,
  runWithSchedulerLock,
}
