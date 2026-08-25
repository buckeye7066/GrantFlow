/**
 * robertAgentAdapter.js
 *
 * Wraps Robert's existing entry point (`runRobert` from
 * backend/services/robert/robertAgent.js) for the Agent Control Center.
 *
 * Robert role inside a full_cycle: funding discovery + opportunity
 * candidate processing + per-profile recommendation. The orchestrator
 * calls Robert in `observe` mode by default — no live web calls — and
 * upgrades to `full-cycle` only when allow_robert_ingest=true and
 * Robert config (ROBERT_ENABLED + ROBERT_ALLOW_LIVE_WEB) permits it.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'
import { getLastRunAtFromEvents } from '../../agentTelemetry/agentTelemetryStore.js'

export class RobertAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'robert',
      label: 'Robert',
      tagline: 'Funding Discovery',
    })
  }

  async getStatus({ db } = {}) {
    const base = await super.getStatus({ db })
    let last = null
    try {
      const row = await db
        ?.prepare('SELECT id, status, mode, started_at, completed_at FROM robert_runs ORDER BY started_at DESC LIMIT 1')
        .get()
      last = row || null
    } catch { /* table may not exist */ }
    const lastRunAt = (await getLastRunAtFromEvents(db, 'robert')) || last?.started_at || null
    return {
      ...base,
      installed: true,
      last_run_at: lastRunAt,
      last_status: last?.status || null,
      health: last?.status === 'failed' ? 'error' : last ? 'healthy' : 'idle',
      details: last,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal } = {}) {
    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'robert', stopped: true } }
    }
    const allowIngest = options?.allow_robert_ingest !== false

    let runRobert
    try {
      ({ runRobert } = await import('../../robert/robertAgent.js'))
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: `Robert not loadable: ${err?.message || err}`,
        summary: { agent: 'robert', error: String(err?.message || err) },
      }
    }

    await signal?.heartbeat?.({ phase: 'starting', allow_ingest: allowIngest })

    // Default mode is observe (read-only coverage analysis). When the admin
    // explicitly authorises ingestion we upgrade to full-cycle, which runs
    // every Robert phase.
    const mode = allowIngest ? 'full-cycle' : 'observe'

    // An admin explicitly authorising ingest through the Control Center IS the
    // authorization to run Robert's full cycle. Without this override, runRobert
    // re-reads the env safe-defaults (ROBERT_ENABLED / ROBERT_ALLOW_LIVE_WEB,
    // both false by default) and could downgrade the requested 'full-cycle' back
    // to read-only 'observe'. Passing an explicit configOverride makes the
    // in-app authorization authoritative over the env defaults; runRobert merges
    // it over getRobertConfig().
    //
    // DISCOVERY ENGINE: Robert now drives the canonical Crawler OS pipeline
    // (registry sources -> SSRF-safe fetcher -> reality gate -> matcher), not the
    // legacy per-plan web-search path. The OS pipeline does NOT consume
    // deps.searchProvider; open-web -> opportunity EXTRACTION is Yana's job, not
    // Robert's (owner role clarification). So we do NOT inject a web search
    // provider here — that wiring was dead for the OS path and only added latency.
    const configOverride = allowIngest
      ? { enabled: true, allowLiveWeb: true, allowSourceDiscovery: true, autoIngestVerified: true }
      : { enabled: true }

    const deps = { configOverride }

    let result
    try {
      result = await runRobert({
        db,
        mode,
        trigger: 'admin-ui',
        deps,
      })
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: String(err?.message || err),
        summary: { agent: 'robert', mode, error: String(err?.message || err) },
      }
    }

    if (signal?.shouldStop?.()) {
      await signal?.recordEvent?.({
        eventType: 'agent.robert.stopped',
        severity: 'medium',
        message: 'Robert stopped after completing in-flight cycle',
        data: { robert_run_id: result?.run_id || null },
      })
      return {
        ok: true,
        status: 'stopped',
        summary: { agent: 'robert', mode, stopped: true, robert_run_id: result?.run_id || null },
      }
    }

    // Honest degradation: runRobert sets a status_reason when a discovery run
    // produced nothing for a CONFIG reason (every funding source skipped for a
    // missing API key, no source selectable, or all fetches failed). We surface
    // that reason on the summary + as a recorded event so the dashboard shows
    // WHY the run was empty — but we do NOT report the step as `failed` (this is
    // not a crash). The run produced 0 work units, so the unified telemetry layer
    // already classifies it as a `noop` (not a healthy "succeeded"); the
    // status_reason explains the noop.
    const statusReason = result?.status_reason || result?.summary?.status_reason || null
    const trueFailure = result?.ok === false && !statusReason

    await signal?.recordEvent?.({
      eventType: 'agent.robert.completed',
      severity: trueFailure ? 'high' : (statusReason ? 'medium' : 'info'),
      message: statusReason
        ? `Robert ${mode} completed with no results — ${statusReason}`
        : `Robert ${mode} ${result?.status || (trueFailure ? 'failed' : 'completed')}`,
      data: {
        robert_run_id: result?.run_id || null,
        mode,
        status_reason: statusReason,
        opportunities_ingested: result?.counters?.opportunities_ingested ?? 0,
        opportunities_matched: result?.counters?.opportunities_matched ?? 0,
        recommendations_created: result?.counters?.recommendations_created ?? 0,
      },
    })

    return {
      // Only a genuine crash/error is `failed`. A config-degraded empty run
      // reports completed (ok:true) but carries status_reason so telemetry shows
      // the real cause (and counts 0 work → noop).
      ok: !trueFailure,
      status: trueFailure ? 'failed' : 'completed',
      status_reason: statusReason,
      error: trueFailure ? (result?.summary?.errors?.[0]?.error || 'robert_run_failed') : null,
      summary: {
        agent: 'robert',
        mode,
        robert_run_id: result?.run_id || null,
        ...(result?.summary || {}),
        status_reason: statusReason,
        // Surface the numeric work counters at the TOP LEVEL (AFTER the spread so
        // they win) so the unified telemetry layer's countAgentWork() — which
        // reads numbers like opportunities_ingested / recommendations_created /
        // candidates_found — classifies a real discovery run as `succeeded`, not
        // `noop`. Robert's own summary nests these in counters / arrays, so
        // without this a genuinely productive run was undercounted to 0 work.
        candidates_found: result?.counters?.candidates_found ?? 0,
        opportunities_ingested: result?.counters?.opportunities_ingested ?? 0,
        opportunities_matched: result?.counters?.opportunities_matched ?? 0,
        recommendations_created: result?.counters?.recommendations_created ?? 0,
      },
    }
  }
}
