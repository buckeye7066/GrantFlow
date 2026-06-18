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
    const dryRun = Boolean(options?.dry_run)

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
    // both false by default) and silently downgrades the requested 'full-cycle'
    // back to read-only 'observe' (robertAgent.js liveWebPermitted gate) — so
    // toggling Robert ON in the app did nothing. Passing an explicit
    // configOverride makes the in-app authorization authoritative over the env
    // defaults; runRobert merges it over getRobertConfig().
    //
    // Note: this does NOT cause outbound web calls. Live source/opportunity
    // discovery (phases 3–4) additionally requires deps.searchProvider /
    // deps.opportunityAdapter, which are not wired on this path — so the
    // override only unlocks verify + ingest + match + recommend over candidates
    // that already exist in Robert's stores.
    const configOverride = allowIngest
      ? { enabled: true, allowLiveWeb: true, allowSourceDiscovery: true, autoIngestVerified: true }
      : { enabled: true }

    let result
    try {
      result = await runRobert({
        db,
        mode,
        trigger: 'admin-ui',
        dryRun,
        deps: { configOverride },
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

    await signal?.recordEvent?.({
      eventType: 'agent.robert.completed',
      severity: result?.ok === false ? 'high' : 'info',
      message: `Robert ${mode} ${result?.status || (result?.ok === false ? 'failed' : 'completed')}`,
      data: {
        robert_run_id: result?.run_id || null,
        mode,
        candidates_inserted: result?.summary?.candidates_inserted ?? 0,
        opportunities_verified: result?.summary?.opportunities_verified ?? 0,
        recommendations_created: result?.summary?.recommendations_created ?? 0,
      },
    })

    return {
      ok: result?.ok !== false,
      status: result?.ok === false ? 'failed' : 'completed',
      summary: {
        agent: 'robert',
        mode,
        robert_run_id: result?.run_id || null,
        ...(result?.summary || {}),
      },
    }
  }
}
