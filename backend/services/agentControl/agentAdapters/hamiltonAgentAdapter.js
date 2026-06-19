/**
 * hamiltonAgentAdapter.js
 *
 * Wraps Hamilton's existing automation entry point
 * (`automateSelected` from
 * backend/services/hamilton/hamiltonAutomationOrchestrator.js) for the
 * Agent Control Center.
 *
 * Hamilton is the Application Autopilot / Funding Completion agent.
 * It is SEPARATE from Yana (Client Discovery). Mixing the two has
 * been a recurring source of bugs, so this adapter only ever drives
 * application_tasks and never reads Yana lead-discovery state.
 *
 * Default behaviour: process the queued Hamilton automation tasks for
 * profiles where Hamilton autopilot has been authorised and
 * allow_hamilton_autopilot=true. If the autopilot toggle is off, the
 * adapter simply records the queue depth and exits with status='skipped'.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'
import { getLastRunAtFromEvents } from '../../agentTelemetry/agentTelemetryStore.js'

export class HamiltonAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'hamilton',
      label: 'Hamilton',
      tagline: 'Application Autopilot / Funding Completion',
    })
  }

  async getStatus({ db } = {}) {
    const base = await super.getStatus({ db })
    let queueDepth = 0
    let openBlockers = 0
    let last = null
    try {
      const r = await db
        ?.prepare(`SELECT COUNT(*) AS c FROM application_tasks WHERE status IN ('queued','running','blocked')`)
        .get()
      queueDepth = Number(r?.c || 0)
    } catch { /* table may not exist */ }
    try {
      const r = await db
        ?.prepare(`SELECT COUNT(*) AS c FROM hamilton_blockers WHERE COALESCE(resolved_at, '') = ''`)
        .get()
      openBlockers = Number(r?.c || 0)
    } catch { /* table may not exist */ }
    try {
      const r = await db
        ?.prepare(`SELECT id, status, started_at FROM hamilton_runs ORDER BY started_at DESC LIMIT 1`)
        .get()
      last = r || null
    } catch { /* table may not exist */ }
    const lastRunAt = (await getLastRunAtFromEvents(db, 'hamilton')) || last?.started_at || null
    return {
      ...base,
      installed: true,
      queue_depth: queueDepth,
      last_run_at: lastRunAt,
      last_status: last?.status || null,
      health: openBlockers > 0 ? 'warning' : last?.status === 'failed' ? 'error' : last ? 'healthy' : 'idle',
      open_blockers: openBlockers,
      details: last,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'hamilton', stopped: true } }
    }
    const enabled = options?.allow_hamilton_autopilot !== false
    const dryRun = Boolean(options?.dry_run)

    // Snapshot queue depth so the event always reports something useful.
    let queueDepth = 0
    try {
      const r = await db
        .prepare(`SELECT COUNT(*) AS c FROM application_tasks WHERE status IN ('queued','running','blocked')`)
        .get()
      queueDepth = Number(r?.c || 0)
    } catch { /* ignore */ }

    if (!enabled) {
      await signal?.recordEvent?.({
        eventType: 'agent.hamilton.skipped',
        severity: 'info',
        message: `Hamilton skipped (allow_hamilton_autopilot=false). Queue depth: ${queueDepth}.`,
        data: { queue_depth: queueDepth, enabled: false },
      })
      return {
        ok: true,
        status: 'skipped',
        summary: { agent: 'hamilton', skipped: true, queue_depth: queueDepth },
      }
    }

    if (dryRun) {
      await signal?.recordEvent?.({
        eventType: 'agent.hamilton.dry_run',
        severity: 'info',
        message: `Hamilton dry run — would process ${queueDepth} task(s).`,
        data: { queue_depth: queueDepth, dry_run: true },
      })
      return {
        ok: true,
        status: 'completed',
        summary: { agent: 'hamilton', dry_run: true, queue_depth: queueDepth },
      }
    }

    // Real run: pick up at most N tasks and call the existing automation
    // orchestrator. Heartbeats are emitted between tasks so the UI shows
    // progress and stop requests get noticed promptly.
    let automateSingleSource
    try {
      ({ automateSingleSource } = await import('../../hamilton/hamiltonAutomationOrchestrator.js'))
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: `Hamilton orchestrator not loadable: ${err?.message || err}`,
        summary: { agent: 'hamilton', error: String(err?.message || err) },
      }
    }

    const maxBatch = Math.max(1, Math.min(25, Number(options?.hamilton_batch_size) || 5))
    let tasks = []
    try {
      // application_tasks tracks the source via opportunity_id / grant_id
      // (the canonical pair from automateSingleSource). The previous SELECT
      // referenced a non-existent `funding_source_id` column AND a
      // non-existent `resolved_at` column, so EVERY Hamilton run silently
      // returned zero tasks and Hamilton looked broken in Mission Control
      // even when the queue had real work. The status set below covers both
      // the legacy ("queued","ready") and automation-task-extension
      // ("analyzing","ready_to_start") flows defined in TASK_STATUSES.
      tasks = await db
        .prepare(`
          SELECT id, profile_id, opportunity_id, grant_id, automation_type,
                 status, current_pipeline_stage, selected_from_stage
            FROM application_tasks
           WHERE status IN ('queued','ready','analyzing','ready_to_start')
           ORDER BY updated_at ASC
           LIMIT ?
        `)
        .all(maxBatch)
      if (!Array.isArray(tasks)) tasks = []
    } catch { /* table missing on bare DBs — empty list is fine */ }

    const results = []
    let processed = 0
    let failed = 0
    let blocked = 0
    let stopped = false

    for (const task of tasks) {
      if (signal?.shouldStop?.()) { stopped = true; break }
      if (signal?.shouldPause?.()) { stopped = true; break }

      await signal?.heartbeat?.({
        phase: 'processing',
        task_id: task.id,
        processed,
        remaining: tasks.length - processed,
      })

      try {
        const r = await automateSingleSource(db, {
          profileId: task.profile_id,
          userId: null,
          // automateSingleSource keys off opportunity_id OR grant_id (it
          // throws "source must include opportunity_id or grant_id" if
          // neither is present). Pass them straight through from the task
          // row so Hamilton processes the right opportunity/grant and the
          // pipeline-stage hint is preserved for stage transitions.
          source: {
            opportunity_id: task.opportunity_id || null,
            grant_id: task.grant_id || null,
            current_stage: task.current_pipeline_stage || task.selected_from_stage || null,
            kind: 'application_task',
          },
          options: { control_run_id: controlRunId },
        })
        results.push({ task_id: task.id, ok: true, status: r?.task?.status || 'unknown' })
        processed += 1
        if (r?.task?.status === 'blocked') blocked += 1
      } catch (err) {
        results.push({ task_id: task.id, ok: false, error: err?.message || String(err) })
        failed += 1
        await signal?.recordEvent?.({
          eventType: 'agent.hamilton.task_failed',
          severity: 'high',
          message: `Hamilton task ${task.id} failed: ${err?.message || err}`,
          data: { task_id: task.id, error: String(err?.message || err) },
        })
      }
    }

    const status = stopped ? 'stopped' : failed > 0 ? 'completed' : 'completed'
    const summary = {
      agent: 'hamilton',
      queue_depth: queueDepth,
      attempted: tasks.length,
      processed,
      failed,
      blocked,
      stopped,
      results,
    }

    await signal?.recordEvent?.({
      eventType: stopped ? 'agent.hamilton.stopped' : 'agent.hamilton.completed',
      severity: failed > 0 ? 'high' : 'info',
      message: stopped
        ? `Hamilton stopped after processing ${processed} of ${tasks.length} task(s).`
        : `Hamilton processed ${processed} task(s) (${failed} failed, ${blocked} blocked).`,
      data: summary,
    })

    return { ok: true, status, summary }
  }
}
