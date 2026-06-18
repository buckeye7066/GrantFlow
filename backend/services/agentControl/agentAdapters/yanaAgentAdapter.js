/**
 * yanaAgentAdapter.js
 *
 * Wraps the Yana Client Discoverer (NOT Hamilton). Yana is the lead-
 * intelligence agent: she discovers prospective-client leads from GrantFlow's
 * organization records, qualifies them, and pushes qualified leads to John's
 * outreach queue.
 *
 * Yana ≠ Hamilton. Hamilton is the application autopilot. Kept as separate
 * adapters with different inputs, queues, telemetry, and stop semantics.
 *
 * Full-cycle behaviour from the Control Center:
 *   1. Discover lead candidates from organizations (deterministic, no network).
 *   2. Qualify candidates above the configured fit threshold.
 *   3. Push qualified leads to John (when allow_yana_leads=true) — John drafts
 *      outreach from them via the registered Yana lead source.
 *
 * Runs are persisted to `yana_lead_runs` (a real table — the old adapter wrote
 * to the renamed `yana_runs` and read a phantom `yana_lead_candidates`, so it
 * never recorded real work).
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'
import { runYanaDiscovery, getYanaStatus, getYanaConfig } from '../../yana/yanaLeadDiscovery.js'

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
    let s = {}
    try {
      s = (await getYanaStatus(db)) || {}
    } catch { /* fresh DBs may not have the tables yet */ }
    const queueDepth = Number(s.queue_depth || 0)
    return {
      ...base,
      installed: true,
      queue_depth: queueDepth,
      last_run_at: s.last_run_at || null,
      last_status: s.last_status || null,
      health: s.last_status === 'failed' ? 'error' : (queueDepth > 0 ? 'healthy' : (s.last_run_at ? 'idle' : 'idle')),
      details: s.details || null,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'yana', stopped: true } }
    }
    const allowLeads = options?.allow_yana_leads !== false
    const dryRun = Boolean(options?.dry_run)

    await signal?.heartbeat?.({ phase: 'discover', allow_leads: allowLeads })

    // dry_run: observe only (qualify but never push to John). Otherwise push
    // qualified leads when allowed.
    const yanaCfg = getYanaConfig()
    const result = await runYanaDiscovery(db, {
      trigger: 'admin-ui',
      allowLeads: allowLeads && !dryRun,
      createdByUserId: options?.user_id || null,
      // Outbound prospect discovery + enrichment touch the live web; gated by
      // YANA_ALLOW_LIVE_WEB (honest NOOP when off).
      allowLiveWeb: yanaCfg.allowLiveWeb,
      prospectLimit: yanaCfg.prospectLimit,
    })

    if (signal?.shouldStop?.()) {
      await signal?.recordEvent?.({
        eventType: 'agent.yana.stopped',
        severity: 'medium',
        message: 'Yana stopped after discovery',
        data: result,
      })
      return { ok: true, status: 'stopped', summary: result }
    }

    await signal?.recordEvent?.({
      eventType: result.ok ? 'agent.yana.completed' : 'agent.yana.failed',
      severity: result.ok ? 'info' : 'warning',
      message: `Yana client discovery — ${result.candidates_qualified} qualified of ${result.candidates_total}, ${result.leads_pushed_to_john} pushed to John`,
      data: result,
    })

    return {
      ok: result.ok !== false,
      status: result.ok === false ? 'failed' : 'completed',
      summary: result,
      error: result.error || null,
    }
  }
}
