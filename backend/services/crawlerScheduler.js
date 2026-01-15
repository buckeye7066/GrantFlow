import cronParser from 'cron-parser'
import crypto from 'crypto'

const SCHEDULER_LOCK_ID = 740912 // arbitrary constant, stable across deploys

function toIsoMinute(date) {
  const d = new Date(date)
  d.setSeconds(0, 0)
  return d.toISOString()
}

function safeParseCron(expr) {
  try {
    return cronParser.parseExpression(expr, { tz: 'UTC' })
  } catch {
    return null
  }
}

function buildIdempotencyKey({ scheduleId, dueAt }) {
  return `schedule:${scheduleId}:${toIsoMinute(dueAt)}`
}

function randomId() {
  return crypto.randomUUID()
}

async function acquireSchedulerLock(tx) {
  if (tx.dialect !== 'postgres') return true
  const row = await tx.prepare(`SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_ID}) as locked`).get()
  return Boolean(row?.locked)
}

async function releaseSchedulerLock(tx) {
  if (tx.dialect !== 'postgres') return
  try {
    await tx.prepare(`SELECT pg_advisory_unlock(${SCHEDULER_LOCK_ID}) as unlocked`).get()
  } catch {
    // ignore
  }
}

/**
 * Enqueue due crawler jobs from crawler_schedules.
 *
 * Design goals:
 * - Idempotent: unique idempotency_key prevents dupes across restarts/instances.
 * - Multi-instance safe: Postgres uses advisory lock to ensure only one scheduler tick runs at a time.
 * - Backward compatible: does not change any API response shapes.
 */
export async function runCrawlerSchedulerTick(db, { now = new Date() } = {}) {
  if (!db) return { ok: false, reason: 'db_missing', enqueued: 0 }

  return await db.withTransaction(async (tx) => {
    const locked = await acquireSchedulerLock(tx)
    if (!locked) {
      return { ok: true, locked: false, enqueued: 0 }
    }

    try {
      const schedules = await tx
        .prepare(
          `
            SELECT id, profile_id, crawler_type, schedule_cron, enabled, last_run_at
            FROM crawler_schedules
            WHERE enabled = 1
          `,
        )
        .all()

      let enqueued = 0
      const errors = []

      for (const s of schedules) {
        const cron = safeParseCron(s.schedule_cron)
        if (!cron) {
          errors.push({ schedule_id: s.id, error: 'invalid_cron' })
          continue
        }

        // Compute the next run time after last_run_at (or created_at-ish fallback).
        const lastRun = s.last_run_at ? new Date(s.last_run_at) : null
        const base = lastRun && !Number.isNaN(lastRun.getTime()) ? lastRun : new Date(0)
        const it = cronParser.parseExpression(s.schedule_cron, { tz: 'UTC', currentDate: base })
        const dueAt = it.next().toDate()

        if (dueAt > now) continue

        const idempotencyKey = buildIdempotencyKey({ scheduleId: s.id, dueAt })

        // Do not enqueue if there is already an in-flight job with this idempotency key.
        const existing = await tx
          .prepare(
            `
              SELECT id
              FROM crawler_jobs
              WHERE idempotency_key = ?
              LIMIT 1
            `,
          )
          .get(idempotencyKey)
        if (existing) continue

        // Also avoid enqueuing if a job of this type/profile is already queued/running.
        const inflight = await tx
          .prepare(
            `
              SELECT id
              FROM crawler_jobs
              WHERE profile_id = ?
                AND type = ?
                AND status IN ('queued','running')
              ORDER BY created_at DESC
              LIMIT 1
            `,
          )
          .get(s.profile_id, s.crawler_type)
        if (inflight) continue

        const jobId = randomId()
        await tx
          .prepare(
            `
              INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by, idempotency_key)
              VALUES (?, ?, 'queued', ?, ?, 'scheduler', ?)
            `,
          )
          .run(jobId, s.crawler_type, s.profile_id, JSON.stringify({ scheduled: true, schedule_id: s.id, due_at: dueAt.toISOString() }), idempotencyKey)

        await tx
          .prepare(
            `
              UPDATE crawler_schedules
              SET last_run_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          )
          .run(s.id)

        enqueued += 1
      }

      return { ok: true, locked: true, enqueued, errors }
    } finally {
      await releaseSchedulerLock(tx)
    }
  })
}

export function startCrawlerScheduler(db, { intervalMs = 60_000 } = {}) {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      const result = await runCrawlerSchedulerTick(db)
      if (result?.enqueued) {
        console.info('[crawlerScheduler] enqueued', { enqueued: result.enqueued, errors: result.errors?.length || 0 })
      }
      if (result?.errors?.length) {
        console.warn('[crawlerScheduler] schedule errors', result.errors.slice(0, 3))
      }
    } catch (error) {
      console.error('[crawlerScheduler] tick failed', error?.message || error)
    }
  }

  tick().catch(() => {})
  const handle = setInterval(() => tick().catch(() => {}), intervalMs)

  return () => {
    stopped = true
    clearInterval(handle)
  }
}

