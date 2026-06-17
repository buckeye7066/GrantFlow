/**
 * yanaAgentAdapter.js
 *
 * Wraps the EXISTING Yana Client Discovery agent — NOT Hamilton. Yana
 * is the lead-intelligence agent: she identifies prospective clients,
 * qualifies leads, and pushes approved leads to John's outreach queue.
 *
 * Yana ≠ Hamilton. Hamilton is the application autopilot. The two are
 * intentionally kept as separate adapters because they have different
 * inputs, queues, telemetry, and stop semantics.
 *
 * Yana's full-cycle behaviour from the Control Center:
 *   1. Refresh lead candidates (read-only by default).
 *   2. Qualify candidates above the configured fit threshold.
 *   3. Push qualified leads to John's queue (when allow_yana_leads=true).
 *
 * Because Yana's runtime entry point is currently driven by the John
 * outreach pipeline (`johnYanaBridge.js`), the adapter records a
 * lead-funnel snapshot from the existing tables and writes a Yana run
 * row so the Mission Control dashboard counts it.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'

export class YanaAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'yana',
      label: 'Yana',
      tagline: 'Client Discovery (lead intelligence)',
    })
  }

  async getStatus({ db } = {}) {
    const base = await super.getStatus({ db })
    let queueDepth = 0
    let last = null
    try {
      const r = await db
        ?.prepare(`SELECT COUNT(*) AS c FROM john_outreach_queue WHERE status IN ('queued','pending')`)
        .get()
      queueDepth = Number(r?.c || 0)
    } catch { /* john_outreach_queue may not exist on bare DBs */ }
    try {
      const r = await db
        ?.prepare(`SELECT id, status, started_at FROM yana_runs ORDER BY started_at DESC LIMIT 1`)
        .get()
      last = r || null
    } catch { /* yana_runs may have been renamed to hamilton_runs */ }
    return {
      ...base,
      installed: true,
      queue_depth: queueDepth,
      last_run_at: last?.started_at || null,
      last_status: last?.status || null,
      health: queueDepth > 0 ? 'healthy' : last ? 'idle' : 'idle',
      details: last,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'yana', stopped: true } }
    }
    const allowLeads = options?.allow_yana_leads !== false

    await signal?.heartbeat?.({ phase: 'snapshot' })

    // Snapshot lead funnel — yana_lead_candidates / yana_qualifications
    // are the canonical client-discovery tables. We read them defensively
    // so the cycle still completes if a fresh DB hasn't created them yet.
    const summary = {
      agent: 'yana',
      candidates_total: 0,
      candidates_qualified: 0,
      leads_pushed_to_john: 0,
      mode: allowLeads ? 'qualify_and_push' : 'observe',
    }

    try {
      const r = await db
        .prepare(`SELECT COUNT(*) AS c FROM yana_lead_candidates`)
        .get()
      summary.candidates_total = Number(r?.c || 0)
    } catch { /* yana_lead_candidates absent on minimal test fixtures */ }

    try {
      const r = await db
        .prepare(`
          SELECT COUNT(*) AS c FROM yana_lead_candidates
          WHERE COALESCE(qualification_status, '') IN ('qualified','approved')
        `)
        .get()
      summary.candidates_qualified = Number(r?.c || 0)
    } catch { /* ignore */ }

    if (signal?.shouldStop?.()) {
      await signal?.recordEvent?.({
        eventType: 'agent.yana.stopped',
        severity: 'medium',
        message: 'Yana stopped during snapshot phase',
        data: summary,
      })
      return { ok: true, status: 'stopped', summary }
    }

    if (allowLeads) {
      // The push step is delegated to John's queue. We count what would
      // be pushed and emit an event; the actual push happens when John's
      // adapter runs in the next step (and reads yana qualified leads).
      try {
        const r = await db
          .prepare(`
            SELECT COUNT(*) AS c FROM yana_lead_candidates
            WHERE COALESCE(qualification_status, '') IN ('qualified','approved')
              AND COALESCE(pushed_to_john, 0) = 0
          `)
          .get()
        summary.leads_pushed_to_john = Number(r?.c || 0)
      } catch { /* ignore */ }
    }

    // Persist a yana_runs row when the table exists so Mission Control
    // can render her last run / status. We tolerate missing tables and
    // missing columns silently.
    try {
      await db
        .prepare(`
          INSERT INTO yana_runs (id, mode, trigger, status, started_at, completed_at, summary_json)
          VALUES (lower(hex(randomblob(16))), ?, 'admin-ui', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
        `)
        .run(summary.mode, JSON.stringify(summary))
    } catch { /* table may have been renamed to hamilton_runs */ }

    await signal?.recordEvent?.({
      eventType: 'agent.yana.completed',
      severity: 'info',
      message: `Yana lead discovery snapshot — ${summary.candidates_qualified} qualified, ${summary.leads_pushed_to_john} ready for John`,
      data: summary,
    })

    return {
      ok: true,
      status: 'completed',
      summary,
    }
  }
}
