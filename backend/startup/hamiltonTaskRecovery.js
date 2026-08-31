/**
 * hamiltonTaskRecovery.js
 *
 * Boot/periodic reconcile for orphaned Hamilton application_tasks.
 *
 * WHY THIS EXISTS
 * ---------------
 * Hamilton's autopilot work runs IN-PROCESS (runAutomationInBackground in the
 * API process / the scheduler tick). A Railway redeploy — which happens on
 * every merge to main — kills that work mid-flight with no chance to clean up.
 * Tasks caught in a transient in-flight status (generating_application,
 * filling_portal, …) survive in the DB but NOTHING ever re-picks them: the
 * HamiltonAgentAdapter resume query only covers queued/ready/analyzing/
 * ready_to_start + due waiting_for_* statuses. Before this module, every
 * redeploy permanently stranded whatever Hamilton was working on, and an
 * operator had to notice and re-kick the batch by hand.
 *
 * THE FIX: demote ordinary in-flight tasks that have gone stale (no update for
 * `staleMinutes`) back to 'ready_to_start' so the normal resume machinery
 * (scheduler tick / adapter / re-POSTed autopilot) picks them up again.
 * Submission-boundary states are different: the external click may already
 * have landed, so restart recovery quarantines them for verification and NEVER
 * requeues them. Re-entering ordinary work from the top is safe;
 * re-entering an ambiguous external submission is not.
 *
 * Staleness (not "am I in-flight") is the trigger so a rolling deploy's
 * OVERLAP window — where the old container may still be driving a task —
 * never causes a double-demotion of genuinely active work. Callers pick the
 * window: boot uses a short one (nothing can be running in a fresh process;
 * only cross-container overlap matters), the scheduler tick uses a longer one
 * (a live portal run with 3 resolver attempts can legitimately hold
 * filling_portal for ~30 minutes).
 */

import {
  appendTaskEvent,
  SUBMISSION_ATTEMPT_STATUSES,
} from '../services/hamilton/applicationTaskStore.js'

/**
 * Transient in-flight statuses that only a live in-process run can advance.
 * waiting_for_* / blocked / review statuses are deliberately NOT here — they
 * are durable hand-off states with their own resume paths (adapter backoff
 * re-pick, human action), not orphans.
 */
export const IN_FLIGHT_STATUSES = Object.freeze([
  'generating_application',
  'generating_documents',
  'saving_documents',
  'launching_portal',
  'filling_portal',
  'saving_portal_draft',
  'in_progress',
])

export const RECOVERY_SCAN_STATUSES = Object.freeze([
  ...IN_FLIGHT_STATUSES,
  ...SUBMISSION_ATTEMPT_STATUSES,
])

const VERIFICATION_REQUIRED_MESSAGE =
  'Hamilton restarted after the external submit step began. The submission may already have reached the funder; verify portal or email confirmation before retrying.'

function toMillis(value) {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Reconcile stale in-flight application_tasks: ordinary work is requeued;
 * ambiguous submission work is quarantined for verification.
 *
 * @returns {{scanned:number, demoted:number, quarantined:number, task_ids:string[], quarantined_task_ids:string[]}}
 */
export async function reconcileOrphanedApplicationTasks(db, {
  staleMinutes = 15,
  now = Date.now(),
  logger = console,
} = {}) {
  const out = {
    scanned: 0,
    demoted: 0,
    quarantined: 0,
    skipped_unchanged: 0,
    runs_closed: 0,
    task_ids: [],
    quarantined_task_ids: [],
  }
  if (!db || typeof db.prepare !== 'function') return out

  let rows = []
  try {
    const placeholders = RECOVERY_SCAN_STATUSES.map(() => '?').join(',')
    rows = await db
      .prepare(`SELECT id, status, updated_at FROM application_tasks WHERE status IN (${placeholders})`)
      .all(...RECOVERY_SCAN_STATUSES)
  } catch {
    // Table missing on bare DBs — nothing to recover.
    return out
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    // No stale TASKS does not mean no stale RUN rows: this sweep already
    // requeued the tasks on a prior pass while the dead runs stayed 'running'
    // forever (prod 2026-08-31 held 201 of them, 199 from a redeploy a week
    // earlier — every dashboard read them as "Working: filling portal").
    out.runs_closed = await closeOrphanedAutopilotRuns(db, { staleMinutes, now, logger })
    return out
  }
  out.scanned = rows.length

  const cutoffMs = staleMinutes * 60_000
  for (const row of rows) {
    const updatedMs = toMillis(row.updated_at)
    // An unparseable/NULL updated_at can't prove the task is fresh — treat as
    // stale so a corrupt timestamp can't strand a task forever.
    const isStale = updatedMs === null || (now - updatedMs) >= cutoffMs
    if (!isStale) continue

    const isAmbiguousSubmission = SUBMISSION_ATTEMPT_STATUSES.includes(row.status)
    try {
      // Compare-and-swap against BOTH the selected status and timestamp. If a
      // live overlapping process advanced or refreshed the row after our scan,
      // recovery must leave it alone rather than clobbering newer truth.
      const hasUpdatedAt = row.updated_at !== null && row.updated_at !== undefined
      // POSTGRES STORES MICROSECONDS; A JS Date CARRIES MILLISECONDS.
      //
      // The guard used to be a bare `updated_at = ?`. On Postgres the driver
      // hands back `2026-08-23T11:18:22.124970` as a JS Date truncated to
      // `.124`, so binding it back could NEVER equal the stored value: the
      // UPDATE matched 0 rows, `changed` was false, the loop `continue`d, and
      // `demoted` stayed 0 — silently, because the summary only logs when
      // demoted > 0. Measured in prod 2026-08-24: 82 of 82 stuck
      // `filling_portal` tasks carried sub-millisecond digits, so recovery was
      // a GUARANTEED no-op there while every SQLite test passed (SQLite stores
      // these as second/millisecond strings that round-trip exactly) — the same
      // shape as the amount_confidence REAL-column bug.
      //
      // The guard's PURPOSE is "leave the row alone if something refreshed it
      // after our scan". A real refresh moves updated_at to now() — seconds or
      // minutes later — so a 1ms upper bound preserves that protection exactly
      // while tolerating the truncation. SQLite keeps the exact equality it
      // already round-trips correctly.
      const isPg = db?.dialect === 'postgres'
      const updatedAtGuard = hasUpdatedAt
        ? (isPg
          ? "updated_at < CAST(? AS timestamptz) + interval '1 millisecond'"
          : 'updated_at = ?')
        : 'updated_at IS NULL'
      const updatedAtParams = hasUpdatedAt ? [row.updated_at] : []
      const nowSql = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      const nextStatus = isAmbiguousSubmission ? 'submission_verification_required' : 'ready_to_start'
      const nextStep = isAmbiguousSubmission ? 'submission_verification_required' : 'recovery'
      const nextMessage = isAmbiguousSubmission
        ? VERIFICATION_REQUIRED_MESSAGE
        : `Hamilton recovered this task: it was stuck at "${row.status}" after a server restart interrupted the run. Requeued to start again automatically.`
      const submitVetoSql = isAmbiguousSubmission
        ? ', auto_submit_enabled = FALSE, allow_auto_submit = FALSE, next_retry_at = NULL'
        : ''
      const result = await db
        .prepare(
          `UPDATE application_tasks
              SET status = ?, current_step = ?, last_agent_message = ?, updated_at = ${nowSql}${submitVetoSql}
            WHERE id = ? AND status = ? AND ${updatedAtGuard}`,
        )
        .run(nextStatus, nextStep, nextMessage, row.id, row.status, ...updatedAtParams)
      const changed = Number(result?.changes ?? result?.rowCount ?? 0) === 1
      if (!changed) {
        // A no-match is legitimate (a live process moved the row first) but it
        // must never be INVISIBLE: a systematic 0-row CAS is exactly how this
        // sweep silently did nothing in prod for weeks. Counted and reported.
        out.skipped_unchanged += 1
        continue
      }

      if (isAmbiguousSubmission) {
        out.quarantined += 1
        out.quarantined_task_ids.push(row.id)
      } else {
        out.demoted += 1
        out.task_ids.push(row.id)
      }

      await appendTaskEvent(db, {
        taskId: row.id,
        eventType: 'note',
        status: nextStatus,
        step: 'recovery',
        message: isAmbiguousSubmission
          ? `Ambiguous submission task (was "${row.status}", stale ≥${staleMinutes} min) quarantined for confirmation verification; it was not requeued.`
          : `Orphaned in-flight task (was "${row.status}", stale ≥${staleMinutes} min) requeued to ready_to_start by restart recovery.`,
        actorRole: 'agent',
        details: {
          recovered_from: row.status,
          stale_minutes: staleMinutes,
          submission_may_have_occurred: isAmbiguousSubmission,
          requeued: !isAmbiguousSubmission,
        },
      })
    } catch (err) {
      logger?.warn?.('[hamilton:recovery] failed to reconcile task', row.id, err?.message || err)
    }
  }

  if (out.demoted > 0) {
    logger?.info?.(`[hamilton:recovery] requeued ${out.demoted}/${out.scanned} orphaned in-flight task(s) to ready_to_start`)
  }
  out.runs_closed = await closeOrphanedAutopilotRuns(db, { staleMinutes, now, logger })
  if (out.skipped_unchanged > 0 && out.demoted === 0 && out.quarantined === 0) {
    logger?.warn?.(
      `[hamilton:recovery] scanned ${out.scanned} stale task(s) and changed NONE — `
      + `${out.skipped_unchanged} compare-and-swap(s) matched 0 rows. This is the `
      + 'signature of a guard that cannot match (see the microsecond note above), not a quiet success.',
    )
  }
  if (out.quarantined > 0) {
    logger?.warn?.(`[hamilton:recovery] quarantined ${out.quarantined}/${out.scanned} ambiguous submission task(s) for verification; none were requeued`)
  }
  return out
}

const ORPHANED_RUN_STATUSES = Object.freeze(['running', 'preflight'])
const ORPHANED_RUN_DETAIL =
  'Run was interrupted (container restart or hung browser) and never recorded a terminal state; closed by restart recovery.'

/**
 * Close hamilton_autopilot_runs rows stuck in a non-terminal status past the
 * stale window. The run executes in-process, so a redeploy or a hung browser
 * kills the work while the row stays 'running' forever — and every dashboard
 * that reads run status then shows "Working…" for a browser that no longer
 * exists (prod 2026-08-31: 201 such rows, 199 of them a week old). The TASK
 * side of that death is handled above; this closes the run-row ghost.
 *
 * Staleness is judged on updated_at in JS (toMillis — dialect-safe), and the
 * UPDATE re-asserts the status in its WHERE so a run that reached a terminal
 * state between scan and write is never clobbered. A run a live process is
 * still driving refreshes its row on every status transition; 45 minutes with
 * no write is the same "nothing can legitimately be this quiet" bar the task
 * sweep uses. Best-effort: a missing table returns 0.
 *
 * @returns {number} rows closed
 */
export async function closeOrphanedAutopilotRuns(db, {
  staleMinutes = 15,
  now = Date.now(),
  logger = console,
} = {}) {
  if (!db || typeof db.prepare !== 'function') return 0
  let rows = []
  try {
    const placeholders = ORPHANED_RUN_STATUSES.map(() => '?').join(',')
    rows = await db
      .prepare(`SELECT id, status, updated_at, created_at FROM hamilton_autopilot_runs WHERE status IN (${placeholders})`)
      .all(...ORPHANED_RUN_STATUSES)
  } catch {
    return 0
  }
  if (!Array.isArray(rows) || rows.length === 0) return 0

  const cutoffMs = staleMinutes * 60_000
  const nowSql = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  let closed = 0
  for (const row of rows) {
    const updatedMs = toMillis(row.updated_at) ?? toMillis(row.created_at)
    // An unreadable timestamp cannot prove the run is fresh — treat as stale,
    // the same posture as the task loop above.
    const isStale = updatedMs === null || (now - updatedMs) >= cutoffMs
    if (!isStale) continue
    try {
      const result = await db
        .prepare(
          `UPDATE hamilton_autopilot_runs
              SET status = 'failed',
                  blocker_kind = COALESCE(blocker_kind, 'interrupted'),
                  blocker_detail = COALESCE(blocker_detail, ?),
                  finished_at = COALESCE(finished_at, ${nowSql}),
                  updated_at = ${nowSql}
            WHERE id = ? AND status = ?`,
        )
        .run(ORPHANED_RUN_DETAIL, row.id, row.status)
      if (Number(result?.changes ?? result?.rowCount ?? 0) === 1) closed += 1
    } catch (err) {
      logger?.warn?.('[hamilton:recovery] failed to close orphaned run', row.id, err?.message || err)
    }
  }
  if (closed > 0) {
    logger?.info?.(`[hamilton:recovery] closed ${closed} orphaned autopilot run(s) stuck in a non-terminal status`)
  }
  return closed
}
