/**
 * johnAgentAdapter.js
 *
 * Wraps John's existing entry point (`runJohn` from
 * backend/services/john/johnAgent.js) for the Agent Control Center.
 *
 * Default behaviour: draft only. John will NEVER send unless the
 * caller explicitly sets `allow_john_send=true` AND John's own
 * config (johnOutreachSafety.draftOnly) permits it. The adapter
 * forces draftOnly=true regardless of options.allow_john_send unless
 * the operator opts in explicitly.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'

export class JohnAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'john',
      label: 'John',
      tagline: 'Outreach Drafts',
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
    } catch { /* table may not exist */ }
    try {
      const r = await db
        ?.prepare(`SELECT id, status, started_at FROM john_runs ORDER BY started_at DESC LIMIT 1`)
        .get()
      last = r || null
    } catch { /* table may not exist */ }
    return {
      ...base,
      installed: true,
      queue_depth: queueDepth,
      last_run_at: last?.started_at || null,
      last_status: last?.status || null,
      health: last?.status === 'failed' ? 'error' : last ? 'healthy' : 'idle',
      details: last,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'john', stopped: true } }
    }
    const allowDrafts = options?.allow_john_drafts !== false
    const allowSend = Boolean(options?.allow_john_send)
    if (!allowDrafts) {
      return {
        ok: true,
        status: 'skipped',
        summary: { agent: 'john', reason: 'allow_john_drafts=false' },
      }
    }

    let runJohn
    try {
      ({ runJohn } = await import('../../john/johnAgent.js'))
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: `John not loadable: ${err?.message || err}`,
        summary: { agent: 'john', error: String(err?.message || err) },
      }
    }

    await signal?.heartbeat?.({ phase: 'starting', allow_send: allowSend })

    let result
    try {
      result = await runJohn({
        db,
        mode: 'draft',
        trigger: 'admin',
        // Force draftOnly unless explicitly authorised. johnOutreachSafety
        // throws if the runtime config disagrees, so this is double-locked.
        draftOnly: !allowSend,
        dryRun: Boolean(options?.dry_run),
      })
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: String(err?.message || err),
        summary: { agent: 'john', error: String(err?.message || err) },
      }
    }

    if (signal?.shouldStop?.()) {
      await signal?.recordEvent?.({
        eventType: 'agent.john.stopped',
        severity: 'medium',
        message: 'John stopped after draft cycle',
        data: { run_id: result?.run_id || null },
      })
      return {
        ok: true,
        status: 'stopped',
        summary: { agent: 'john', stopped: true, run_id: result?.run_id || null },
      }
    }

    await signal?.recordEvent?.({
      eventType: 'agent.john.completed',
      severity: result?.ok === false ? 'high' : 'info',
      message: `John ${result?.ok === false ? 'failed' : 'drafted'} — ${result?.drafts_created || 0} drafts, ${result?.drafts_blocked || 0} blocked`,
      data: {
        john_run_id: result?.run_id || null,
        drafts_created: result?.drafts_created ?? 0,
        drafts_blocked: result?.drafts_blocked ?? 0,
        leads_considered: result?.leads_considered ?? 0,
        allow_send: allowSend,
      },
    })

    return {
      ok: result?.ok !== false,
      status: result?.ok === false ? 'failed' : 'completed',
      summary: {
        agent: 'john',
        john_run_id: result?.run_id || null,
        drafts_created: result?.drafts_created ?? 0,
        drafts_blocked: result?.drafts_blocked ?? 0,
        drafts_failed: result?.drafts_failed ?? 0,
        leads_considered: result?.leads_considered ?? 0,
        allow_send: allowSend,
      },
    }
  }
}
