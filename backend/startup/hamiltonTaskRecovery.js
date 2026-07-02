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
 * THE FIX: demote in-flight tasks that have gone stale (no update for
 * `staleMinutes`) back to 'ready_to_start' so the normal resume machinery
 * (scheduler tick / adapter / re-POSTed autopilot) picks them up again.
 * Re-entering from the top is safe: ensureApplicationTask is idempotent per
 * (profile, opportunity/grant) and generated-document saves are idempotent
 * (PR #757), so a re-run never duplicates tasks or packets.
 *
 * Staleness (not "am I in-flight") is the trigger so a rolling deploy's
 * OVERLAP window — where the old container may still be driving a task —
 * never causes a double-demotion of genuinely active work. Callers pick the
 * window: boot uses a short one (nothing can be running in a fresh process;
 * only cross-container overlap matters), the scheduler tick uses a longer one
 * (a live portal run with 3 resolver attempts can legitimately hold
 * filling_portal for ~30 minutes).
 */

import { updateApplicationTask, appendTaskEvent } from '../services/hamilton/applicationTaskStore.js'

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

function toMillis(value) {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Demote stale in-flight application_tasks back to ready_to_start.
 *
 * @returns {{scanned:number, demoted:number, task_ids:string[]}}
 */
export async function reconcileOrphanedApplicationTasks(db, {
  staleMinutes = 15,
  now = Date.now(),
  logger = console,
} = {}) {
  const out = { scanned: 0, demoted: 0, task_ids: [] }
  if (!db || typeof db.prepare !== 'function') return out

  let rows = []
  try {
    const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',')
    rows = await db
      .prepare(`SELECT id, status, updated_at FROM application_tasks WHERE status IN (${placeholders})`)
      .all(...IN_FLIGHT_STATUSES)
  } catch {
    // Table missing on bare DBs — nothing to recover.
    return out
  }
  if (!Array.isArray(rows) || rows.length === 0) return out
  out.scanned = rows.length

  const cutoffMs = staleMinutes * 60_000
  for (const row of rows) {
    const updatedMs = toMillis(row.updated_at)
    // An unparseable/NULL updated_at can't prove the task is fresh — treat as
    // stale so a corrupt timestamp can't strand a task forever.
    const isStale = updatedMs === null || (now - updatedMs) >= cutoffMs
    if (!isStale) continue
    try {
      await updateApplicationTask(db, row.id, {
        status: 'ready_to_start',
        lastAgentMessage:
          `Hamilton recovered this task: it was stuck at "${row.status}" after a server restart interrupted the run. Requeued to start again automatically.`,
      })
      await appendTaskEvent(db, {
        taskId: row.id,
        eventType: 'note',
        status: 'ready_to_start',
        step: 'recovery',
        message: `Orphaned in-flight task (was "${row.status}", stale ≥${staleMinutes} min) requeued to ready_to_start by restart recovery.`,
        actorRole: 'agent',
        details: { recovered_from: row.status, stale_minutes: staleMinutes },
      })
      out.demoted += 1
      out.task_ids.push(row.id)
    } catch (err) {
      logger?.warn?.('[hamilton:recovery] failed to requeue task', row.id, err?.message || err)
    }
  }

  if (out.demoted > 0) {
    logger?.info?.(`[hamilton:recovery] requeued ${out.demoted}/${out.scanned} orphaned in-flight task(s) to ready_to_start`)
  }
  return out
}
