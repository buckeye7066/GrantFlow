/**
 * anyaAgentAdapter.js
 *
 * STATUS-ONLY Control-Center adapter for Anya. Anya is the user-facing guide /
 * administrative assistant — she is invoked on demand to explain and route, and
 * is intentionally NOT part of the automated full-cycle (Sam→Robert→Yana→John→
 * Hamilton). The charter audit (2026-06-23) found she was invisible in the
 * Control-Center status surface (ALL_AGENTS had no 'anya', no adapter), which
 * violates the agent-observability rule (every agent must be visible to Sam +
 * the Control Center). This adapter surfaces her health from anya_runs /
 * anya_tool_usage WITHOUT making her a runnable scheduled loop: start/pause/
 * stop are explicit no-ops that report she is interactive-only.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'

export class AnyaAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({ name: 'anya', label: 'Anya', tagline: 'Administrative Assistant / User Guide' })
  }

  async getStatus({ db } = {}) {
    const base = await super.getStatus({ db })
    let lastRunAt = null
    let lastStatus = null
    let runs24h = 0
    let toolCalls24h = 0
    try {
      const r = await db
        ?.prepare(`SELECT status, created_at FROM anya_runs ORDER BY created_at DESC LIMIT 1`)
        .get()
      if (r) { lastStatus = r.status || null; lastRunAt = r.created_at || null }
    } catch { /* table may not exist */ }
    try {
      const since = db?.dialect === 'postgres' ? `(now() - interval '24 hours')` : `datetime('now','-24 hours')`
      const r = await db?.prepare(`SELECT COUNT(*) AS c FROM anya_runs WHERE created_at >= ${since}`).get()
      runs24h = Number(r?.c || 0)
    } catch { /* ignore */ }
    try {
      const since = db?.dialect === 'postgres' ? `(now() - interval '24 hours')` : `datetime('now','-24 hours')`
      const r = await db?.prepare(`SELECT COUNT(*) AS c FROM anya_tool_usage WHERE created_at >= ${since}`).get()
      toolCalls24h = Number(r?.c || 0)
    } catch { /* ignore */ }
    return {
      ...base,
      installed: true,
      interactive_only: true, // not a scheduled loop — invoked on demand
      last_run_at: lastRunAt,
      last_status: lastStatus,
      health: lastStatus === 'failed' ? 'warning' : lastRunAt ? 'healthy' : 'idle',
      runs_24h: runs24h,
      tool_calls_24h: toolCalls24h,
      notes: ['Anya is interactive (on-demand); she is not part of the automated full-cycle.'],
    }
  }

  // Anya is on-demand: she is never started/paused/stopped by the Control-Center
  // scheduler. These report an honest no-op rather than throwing.
  async start() {
    return {
      ok: true,
      status: 'skipped',
      summary: { agent: 'anya', skipped: true, reason: 'anya_is_interactive_only' },
    }
  }

  async pause() { return { ok: true, paused: false, reason: 'anya_is_interactive_only' } }
  async stop() { return { ok: true, stopped: false, reason: 'anya_is_interactive_only' } }
  async resume() { return { ok: true, resumed: false, reason: 'anya_is_interactive_only' } }
  async health(args) { return this.getStatus(args) }
}

export default { AnyaAgentAdapter }
