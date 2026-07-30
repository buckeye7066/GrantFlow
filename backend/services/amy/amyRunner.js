/**
 * amyRunner.js
 *
 * Shared, single-flight, BACKGROUND launcher for Amy training runs, used by BOTH
 * the on-demand admin route (POST /api/amy/run) and the daily scheduler.
 *
 * Why this exists: an Amy run crawls up to 100 synthetic profiles live and then
 * runs the Anya→Sam improvement pipeline (LLM calls) — minutes of work. If the
 * HTTP handler awaits that, Railway's edge proxy times the request out with a
 * 504 long before it finishes. So a run must NEVER block a request: we start it
 * in the background, return a run id immediately, and let the panel poll status.
 *
 * Responsibilities (the "how a run is started/observed", not the "what it does"):
 *   - track in-memory run state so the admin panel can poll progress;
 *   - guarantee single-flight locally (in-memory flag) AND across instances
 *     (DB scheduler lock) so a manual run and the daily run never double-run;
 *   - write the same audit artifacts the scheduler used to write;
 *   - expose a tightly fenced recovery path for an orphaned scheduler lease
 *     that predates the current process and produced no durable Amy activity.
 *
 * The orchestration itself lives in amyAgent.runAmyTraining().
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAmyTraining } from './amyAgent.js'
import { runWithSchedulerLock } from '../schedulerLock.js'
import { getLock, releaseLock } from '../agentControl/agentControlStore.js'
import { newRunId } from './amyMetadata.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../')
const LOCK_NAME = 'amy:training'
export const AMY_SCHEDULER_LOCK_NAME = `scheduler:${LOCK_NAME}`
const LOCK_TTL_MS = 2 * 60 * 60 * 1000
const DEFAULT_RECOVERY_MIN_AGE_MS = 5 * 60 * 1000
const PROCESS_STARTED_AT = new Date().toISOString()

// Single source of truth for "is Amy running right now", shared across the
// admin route and the scheduler so the panel reflects either trigger.
const state = {
  running: false,
  run_id: null,
  source: null,
  phase: 'idle',
  started_at: null,
  finished_at: null,
  ok: null,
  error: null,
  summary: null,
}

/** Snapshot of the current/last run for the admin panel to poll. */
export function getAmyRunState() {
  return { ...state, process_started_at: PROCESS_STARTED_AT }
}

async function makeArtifactWriter() {
  const dir = path.join(REPO_ROOT, 'audit-reports')
  await fs.mkdir(dir, { recursive: true })
  return async (relName, jsonStr) => {
    const full = path.join(dir, relName)
    await fs.writeFile(full, jsonStr, 'utf8')
    return path.relative(REPO_ROOT, full)
  }
}

async function countSince(db, sql, since) {
  // Recovery is destructive with respect to the lease, so evidence reads must
  // fail closed. A missing table, schema drift, or transient DB error is not
  // proof of zero activity and must leave the lock untouched.
  const row = await db.prepare(sql).get(since)
  const count = Number(row?.n)
  if (!Number.isFinite(count) || count < 0) {
    throw new Error('Amy lock recovery could not prove a valid durable activity count')
  }
  return count
}

/** Read the durable Amy scheduler lease without mutating it. */
export async function inspectAmySchedulerLock(db) {
  return getLock(db, AMY_SCHEDULER_LOCK_NAME)
}

/**
 * Recover an Amy lock left behind by a process that no longer exists.
 *
 * Safety fences:
 *   1. exact control_run_id supplied by the administrator;
 *   2. no Amy run active in this process;
 *   3. the lease predates this process and is at least five minutes old;
 *   4. zero Amy profiles and zero Amy telemetry events were created since the
 *      lease began. A run that produced evidence is left for normal TTL expiry.
 */
export async function recoverStaleAmyRunLock({
  db,
  controlRunId,
  logger = console,
  minAgeMs = DEFAULT_RECOVERY_MIN_AGE_MS,
  now = new Date(),
} = {}) {
  if (!db) return { recovered: false, reason: 'db_required' }
  if (!controlRunId) return { recovered: false, reason: 'control_run_id_required' }
  if (state.running) return { recovered: false, reason: 'local_run_active', run_id: state.run_id }

  const lock = await inspectAmySchedulerLock(db)
  if (!lock) return { recovered: false, reason: 'no_lock' }
  if (String(lock.control_run_id) !== String(controlRunId)) {
    return { recovered: false, reason: 'control_run_id_mismatch', lock }
  }

  const acquiredMs = Date.parse(lock.acquired_at)
  const processMs = Date.parse(PROCESS_STARTED_AT)
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(acquiredMs) || !Number.isFinite(processMs) || !Number.isFinite(nowMs)) {
    return { recovered: false, reason: 'invalid_lock_timestamps', lock }
  }
  if (acquiredMs >= processMs) {
    return { recovered: false, reason: 'lock_does_not_predate_process', lock, process_started_at: PROCESS_STARTED_AT }
  }
  const ageMs = nowMs - acquiredMs
  const minimum = Math.max(60_000, Number(minAgeMs) || DEFAULT_RECOVERY_MIN_AGE_MS)
  if (ageMs < minimum) {
    return { recovered: false, reason: 'lock_too_fresh', lock, age_ms: ageMs, minimum_age_ms: minimum }
  }

  const [profilesCreated, eventsRecorded] = await Promise.all([
    countSince(
      db,
      "SELECT COUNT(*) AS n FROM profiles WHERE created_by = 'agent:amy' AND created_at >= ?",
      lock.acquired_at,
    ),
    countSince(
      db,
      "SELECT COUNT(*) AS n FROM agent_activity_events WHERE agent_name = 'amy' AND created_at >= ?",
      lock.acquired_at,
    ),
  ])
  if (profilesCreated > 0 || eventsRecorded > 0) {
    return {
      recovered: false,
      reason: 'durable_activity_detected',
      lock,
      profiles_created: profilesCreated,
      events_recorded: eventsRecorded,
    }
  }

  const released = await releaseLock(db, {
    lockName: AMY_SCHEDULER_LOCK_NAME,
    controlRunId: lock.control_run_id,
    ownerToken: lock.owner_token,
  })
  const recovered = released === 1
  if (recovered) {
    logger?.warn?.('amy.orphaned_scheduler_lock_recovered', {
      control_run_id: lock.control_run_id,
      acquired_at: lock.acquired_at,
      process_started_at: PROCESS_STARTED_AT,
      age_ms: ageMs,
    })
  }
  return {
    recovered,
    reason: recovered ? 'orphaned_zero_activity_lock_released' : 'release_failed',
    released,
    lock,
    profiles_created: profilesCreated,
    events_recorded: eventsRecorded,
    process_started_at: PROCESS_STARTED_AT,
    age_ms: ageMs,
  }
}

/**
 * Start an Amy run in the BACKGROUND. Returns immediately; never awaits the run.
 * If a run is already in flight (this instance), returns { already_running: true }
 * without starting a second one. Cross-instance overlap is additionally guarded
 * by the DB scheduler lock.
 *
 * @param {object} p
 *   db, logger, source ('admin'|'scheduler'|'startup'), opts (forwarded verbatim
 *   to runAmyTraining), withArtifacts (default true).
 * @returns {{ run_id: string|null, already_running: boolean, promise: Promise<any> }}
 *   The promise resolves when the run finishes; callers may ignore it.
 */
export function launchAmyRun({ db, logger = console, source = 'admin', opts = {}, withArtifacts = true } = {}) {
  if (state.running) {
    return { run_id: state.run_id, already_running: true, promise: Promise.resolve(null) }
  }

  const runId = opts.runId || newRunId(new Date())
  state.running = true
  state.run_id = runId
  state.source = source
  state.phase = 'preparing'
  state.started_at = new Date().toISOString()
  state.finished_at = null
  state.ok = null
  state.error = null
  state.summary = null

  const promise = (async () => {
    try {
      let writeArtifact = null
      if (withArtifacts) {
        try { writeArtifact = await makeArtifactWriter() } catch { writeArtifact = null }
      }
      state.phase = 'acquiring_lock'
      const result = await runWithSchedulerLock(
        db,
        { lockName: LOCK_NAME, ttlMs: LOCK_TTL_MS, logger, acquiredBy: `amy:${source}` },
        () => {
          state.phase = 'training'
          return runAmyTraining({ db, runId, writeArtifact, logger, ...opts })
        },
      )
      if (result?.skipped) {
        // Another instance/run already holds the lock — not an error.
        logger?.info?.('amy.run.skipped_lock_held', { run_id: runId, source })
        state.ok = true
        state.phase = 'skipped'
        state.summary = { skipped: true, reason: 'lock_held' }
        return result
      }
      state.ok = true
      state.phase = 'completed'
      state.summary = result?.summary || null
      logger?.info?.('amy.run.complete', { run_id: result?.run_id || runId, source, ...(result?.summary || {}) })
      return result
    } catch (err) {
      state.ok = false
      state.phase = 'failed'
      state.error = String(err?.message || err)
      logger?.error?.('amy.run.error', { run_id: runId, source, message: state.error })
      return { error: state.error }
    } finally {
      state.running = false
      state.finished_at = new Date().toISOString()
    }
  })()

  // Don't let an unobserved rejection crash the process; state already captured it.
  promise.catch(() => {})

  return { run_id: runId, already_running: false, promise }
}

export default {
  AMY_SCHEDULER_LOCK_NAME,
  launchAmyRun,
  getAmyRunState,
  inspectAmySchedulerLock,
  recoverStaleAmyRunLock,
}
