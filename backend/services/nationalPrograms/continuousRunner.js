import crypto from 'crypto'
import { dispatchCrawlerJob } from '../crawlerDispatcher.js'
import { auditLog } from './audit.js'
import { createLogger } from '../../utils/logger.js'
import { runWithSchedulerLock, reportBackgroundError } from '../schedulerLock.js'
import { maybeCleanupStaleRunningJobs } from '../crawlerConcurrencyGuard.js'
import { isSupersededCrawlerType, SUPERSEDED_REASON } from '../../../shared/supersededCrawlerTypes.js'
const qualityLog = createLogger('services:nationalPrograms:continuousRunner')

/**
 * The crawler_jobs.type this runner drives. Kept as a named constant so the
 * superseded check in `startNationalProgramsCrawler` states plainly which type
 * it is asserting about; the SQL below embeds the same literal.
 */
const NATIONAL_JOB_TYPE = 'national'

function minutes(ms) {
  return Math.round(ms / 60000)
}

// A national job that has sat 'queued'/'running' longer than this is presumed
// dead (the process was redeployed/killed before dispatch transitioned or
// finished it). The overlap guard below treats ANY queued/running national job
// as a live run, so a stranded one wedges the crawler forever — which is exactly
// how the canonical catalog ends up with 0 national_programs rows despite the
// crawler being ENABLED. We reclaim past this age and proceed. A real national
// crawl (maxUrls≈200, maxDepth≈2) finishes in minutes; 45 min is generous.
const NATIONAL_JOB_WEDGE_MS = parseInt(process.env.NATIONAL_PROGRAMS_JOB_WEDGE_MS || String(45 * 60 * 1000), 10)

/** Parse a DB timestamp (ISO or 'YYYY-MM-DD HH:MM:SS' UTC) to age in ms, or null. */
export function ageMsFrom(ts, now = Date.now()) {
  if (!ts) return null
  const raw = ts instanceof Date ? ts.toISOString() : String(ts)
  // SQLite CURRENT_TIMESTAMP has no zone and is UTC — make that explicit so the
  // local runtime doesn't misread it as local time.
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  const t = Date.parse(normalized)
  return Number.isFinite(t) ? now - t : null
}

/**
 * Decide what to do with an in-flight national job found by the overlap guard.
 * A job stranded 'queued'/'running' past NATIONAL_JOB_WEDGE_MS (process killed
 * by a redeploy before dispatch finished) wedges the crawler forever, starving
 * the canonical catalog. We reclaim it (mark failed) so a fresh run can proceed.
 *
 * Returns `{ skip }`: skip=true means a genuinely-live job is running → bail;
 * skip=false means either no blocker or the blocker was reclaimed → proceed.
 * Exported for unit testing.
 */
export async function reclaimWedgedNationalJob(db, existing, { now = Date.now() } = {}) {
  if (!existing) return { skip: false, reclaimed: false }
  const ageMs = ageMsFrom(existing.created_at, now)
  const wedged = ageMs !== null && ageMs > NATIONAL_JOB_WEDGE_MS
  if (!wedged) {
    await auditLog({
      action: 'continuous_skip',
      reason: 'existing_job_in_progress',
      job_id: existing.id,
      status: existing.status,
    })
    return { skip: true, reclaimed: false, ageMs }
  }
  try {
    await db
      .prepare("UPDATE crawler_jobs SET status = 'failed', error = ? WHERE id = ? AND status IN ('queued', 'running')")
      .run('reclaimed: stale national-programs job wedged the continuous crawler', existing.id)
  } catch (reclaimError) {
    reportBackgroundError(reclaimError, { lockName: 'national-programs-crawler', phase: 'reclaim_wedged_job' })
  }
  await auditLog({
    action: 'continuous_reclaim_wedged',
    job_id: existing.id,
    status: existing.status,
    age_minutes: minutes(ageMs),
  })
  return { skip: false, reclaimed: true, ageMs }
}

export function startNationalProgramsCrawler({
  db,
  uploadDir,
  intervalMinutes = 360,
  maxUrls = 200,
  maxDepth = 2,
  agents = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('Database connection required for national programs crawler')

  // A ZERO-WORK LOOP MUST BE LOUD, NOT SCHEDULED.
  //
  // This runner enqueues `crawler_jobs.type = 'national'` with a RAW INSERT,
  // which bypasses `createCrawlerJob` — the choke point that refuses retired
  // discovery types. `'national'` is in `shared/supersededCrawlerTypes.js`, so
  // `crawlerDispatcher` short-circuits every one of these jobs to
  // `status='completed', error=SUPERSEDED_REASON` without executing anything.
  //
  // The net effect before this guard: every `intervalMinutes` (default 360) the
  // lane wrote `continuous_job_created` and `continuous_tick_complete` to the
  // audit log and discovered exactly zero national programs — a lane that reads
  // as running while doing nothing. (It also made `reclaimWedgedNationalJob` and
  // the whole NATIONAL_JOB_WEDGE_MS machinery unreachable: a job can never
  // linger in queued/running when the dispatcher completes it synchronously.)
  //
  // Refuse to schedule, say so once at full volume, and record it — rather than
  // manufacturing an audit trail of work that cannot happen. Grant discovery is
  // the Crawler OS's job now; re-enabling this lane means giving it a live job
  // type, not silencing this check.
  if (isSupersededCrawlerType(NATIONAL_JOB_TYPE)) {
    qualityLog.error(
      `[national-programs] NOT STARTED: crawler job type '${NATIONAL_JOB_TYPE}' is superseded (${SUPERSEDED_REASON}). ` +
        'Every tick would enqueue a job the dispatcher completes without running it. ' +
        'National program discovery runs through the Crawler OS; this lane stays off until it has a live job type.',
    )
    auditLog({
      action: 'continuous_disabled_superseded',
      job_type: NATIONAL_JOB_TYPE,
      reason: SUPERSEDED_REASON,
    }).catch(() => {})
    return () => {}
  }

  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000

  const tickUnlocked = async () => {
    const startedAt = Date.now()
    try {
      // Self-heal first: reclaim dead 'running' jobs (heartbeat/started-at aware)
      // across all crawler types so a worker killed by a deploy doesn't hold a
      // lock. Best-effort — never block the tick on cleanup.
      try {
        await maybeCleanupStaleRunningJobs(db)
      } catch (cleanupError) {
        reportBackgroundError(cleanupError, { lockName: 'national-programs-crawler', phase: 'stale_cleanup' })
      }

      // Avoid overlapping runs
      let existing;
      try {
        existing = await db
          .prepare(
            `
              SELECT id, status, created_at
              FROM crawler_jobs
              WHERE type = 'national'
                AND (status = 'queued' OR status = 'running')
                AND (
                  parameters LIKE '%"mode":"programs"%'
                  OR parameters LIKE '%"mode": "programs"%'
                )
              ORDER BY created_at DESC
              LIMIT 1
            `,
          )
          .get()
      } catch (dbError) {
        reportBackgroundError(dbError, { lockName: 'national-programs-crawler', phase: 'existing_job_check' })
        await auditLog({
          action: 'continuous_db_error',
          error: dbError instanceof Error ? dbError.message : String(dbError),
        })
        return
      }

      if (existing) {
        // Reclaim a stranded job (or bail if a genuinely-live run is in flight).
        const { skip } = await reclaimWedgedNationalJob(db, existing)
        if (skip) return
        // otherwise fall through to enqueue a fresh run below
      }

      const jobId = crypto.randomUUID()
      const parameters = {
        mode: 'programs',
        max_urls: maxUrls,
        max_depth: maxDepth,
        ...(Array.isArray(agents) ? { agents } : {}),
        continuous_run: true,
      }

      try {
        await db.prepare(
          `
            INSERT INTO crawler_jobs (id, type, status, parameters, requested_by, created_at)
            VALUES (?, 'national', 'queued', ?, 'system', CURRENT_TIMESTAMP)
          `,
        ).run(jobId, JSON.stringify(parameters))
      } catch (insertError) {
        reportBackgroundError(insertError, { lockName: 'national-programs-crawler', phase: 'insert_job' })
        await auditLog({
          action: 'continuous_insert_error',
          job_id: jobId,
          error: insertError instanceof Error ? insertError.message : String(insertError),
        })
        return
      }

      await auditLog({
        action: 'continuous_job_created',
        job_id: jobId,
        parameters,
      })

      // Fire-and-forget dispatch
      dispatchCrawlerJob({
        db,
        jobId,
        uploadDir,
        getOpenAI: () => null,
      }).catch(async (err) => {
        await auditLog({
          action: 'continuous_dispatch_error',
          job_id: jobId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Mark job as failed in database so it doesn't block future runs
        try {
          await db.prepare("UPDATE crawler_jobs SET status = 'failed' WHERE id = ?").run(jobId)
        } catch (updateError) {
          reportBackgroundError(updateError, { lockName: 'national-programs-crawler', phase: 'mark_dispatch_failed' })
          qualityLog.error('Failed to update job status:', updateError)
        }
      })
    } catch (error) {
      reportBackgroundError(error, { lockName: 'national-programs-crawler', phase: 'tick' })
      await auditLog({
        action: 'continuous_tick_error',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await auditLog({
        action: 'continuous_tick_complete',
        duration_minutes: minutes(Date.now() - startedAt),
      })
    }
  }

  const tick = () => runWithSchedulerLock(db, {
    lockName: 'national-programs-crawler',
    ttlMs: Math.max(intervalMs, 30 * 60 * 1000),
    logger: console,
  }, tickUnlocked)

  // Kick off immediately, then on interval
  tick().catch(e => console.warn('[background]', e?.message || e))
  const handle = setInterval(() => tick().catch(e => console.warn('[background]', e?.message || e)), intervalMs)
  return () => clearInterval(handle)
}
