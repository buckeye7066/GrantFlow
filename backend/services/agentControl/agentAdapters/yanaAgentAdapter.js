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
import { getLastRunAtFromEvents } from '../../agentTelemetry/agentTelemetryStore.js'
import { resolveStatesFromDirective } from '../directiveGeoResolver.js'

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
    const lastRunAt = (await getLastRunAtFromEvents(db, 'yana')) || s.last_run_at || null
    return {
      ...base,
      installed: true,
      queue_depth: queueDepth,
      last_run_at: lastRunAt,
      last_status: s.last_status || null,
      health: s.last_status === 'failed' ? 'error' : (queueDepth > 0 ? 'healthy' : (lastRunAt ? 'idle' : 'idle')),
      details: s.details || null,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'yana', stopped: true } }
    }
    const allowLeads = options?.allow_yana_leads !== false

    await signal?.heartbeat?.({ phase: 'discover', allow_leads: allowLeads })

    // Owner-attached free-text instruction. Yana's prospect discovery already
    // has a real per-source geography override (providerArgs.bySource); a
    // directive that names a US state ("focus on Tennessee") scopes THIS
    // run's ProPublica 990 prospect search to it. A directive that doesn't
    // name a state has no behavior effect (recorded on the run either way —
    // never faked as applied).
    const directive = typeof options?.directives?.yana === 'string' ? options.directives.yana : null
    const directiveStates = directive ? resolveStatesFromDirective(directive) : []
    const prospectDeps = directiveStates.length
      ? { providerArgs: { bySource: { propublica_990: { states: directiveStates } } } }
      : {}

    const yanaCfg = getYanaConfig()
    const result = await runYanaDiscovery(db, {
      trigger: 'admin-ui',
      allowLeads,
      createdByUserId: options?.user_id || null,
      // Outbound prospect discovery + enrichment touch the live web; gated by
      // YANA_ALLOW_LIVE_WEB (honest NOOP when off).
      allowLiveWeb: yanaCfg.allowLiveWeb,
      prospectLimit: yanaCfg.prospectLimit,
      backlogEnrichLimit: yanaCfg.backlogEnrichLimit,
      prospectDeps,
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

    // Honest reporting: when Yana qualified nothing, surface WHY (her
    // noop_reason already explains it — e.g. live-web/prospect discovery
    // disabled, or N of M orgs lacked a usable email).
    const noopReason = result?.noop_reason || null
    const baseMsg = `Yana client discovery — ${result.candidates_qualified} qualified of ${result.candidates_total}, ${result.leads_pushed_to_john} pushed to John`
    await signal?.recordEvent?.({
      eventType: result.ok ? 'agent.yana.completed' : 'agent.yana.failed',
      severity: result.ok ? 'info' : 'warning',
      message: noopReason ? `${baseMsg} — ${noopReason}` : baseMsg,
      data: { ...result, directive_applied: directive || undefined, directive_states: directiveStates.length ? directiveStates : undefined },
    })

    return {
      ok: result.ok !== false,
      status: result.ok === false ? 'failed' : 'completed',
      status_reason: noopReason,
      summary: { ...result, directive_applied: directive || null, directive_states: directiveStates },
      error: result.error || null,
    }
  }
}
