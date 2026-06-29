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
 *   - write the same audit artifacts the scheduler used to write.
 *
 * The orchestration itself lives in amyAgent.runAmyTraining().
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAmyTraining } from './amyAgent.js'
import { runWithSchedulerLock } from '../schedulerLock.js'
import { newRunId } from './amyMetadata.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../')
const LOCK_NAME = 'amy:training'
const LOCK_TTL_MS = 2 * 60 * 60 * 1000

// Single source of truth for "is Amy running right now", shared across the
// admin route and the scheduler so the panel reflects either trigger.
const state = {
  running: false,
  run_id: null,
  source: null,
  started_at: null,
  finished_at: null,
  ok: null,
  error: null,
  summary: null,
}

/** Snapshot of the current/last run for the admin panel to poll. */
export function getAmyRunState() {
  return { ...state }
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
      const result = await runWithSchedulerLock(
        db,
        { lockName: LOCK_NAME, ttlMs: LOCK_TTL_MS, logger, acquiredBy: `amy:${source}` },
        () => runAmyTraining({ db, runId, writeArtifact, logger, ...opts }),
      )
      if (result?.skipped) {
        // Another instance/run already holds the lock — not an error.
        logger?.info?.('amy.run.skipped_lock_held', { run_id: runId, source })
        state.ok = true
        state.summary = { skipped: true, reason: 'lock_held' }
        return result
      }
      state.ok = true
      state.summary = result?.summary || null
      logger?.info?.('amy.run.complete', { run_id: result?.run_id || runId, source, ...(result?.summary || {}) })
      return result
    } catch (err) {
      state.ok = false
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

export default { launchAmyRun, getAmyRunState }
