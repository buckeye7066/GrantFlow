/**
 * samAgentAdapter.js
 *
 * Wraps Sam's existing entry points (`runSam` from
 * backend/services/sam/samAgent.js) for the Agent Control Center.
 *
 * Sam's role inside a full_cycle:
 *   - preflight  → run before Robert/Yana/John/Hamilton
 *   - postflight → run after them, including a quick health probe of
 *                  every other agent so silent failures get caught.
 *
 * The orchestrator calls start({ stage: 'preflight' | 'postflight' })
 * to pick the right behaviour; default is a single observe run.
 */

import { BaseAgentAdapter } from './baseAgentAdapter.js'
import { getLastRunAtFromEvents } from '../../agentTelemetry/agentTelemetryStore.js'

// Sam runs server-side as a trusted internal operator (it is only ever
// triggered by the canonical-admin-gated Agent Control Center). Its admin
// tool invocations flow through anyaOrchestrator.invokeTool → assertAuthenticated,
// which requires a non-null userId, and then anyaToolRegistry, which authorises
// on ctx.isAdmin === true. A null userId made every admin tool call 401 with
// "Tool invocation failed". We give Sam an explicit internal admin principal:
// a stable synthetic userId (audit_logs.user_id has no FK, so this is safe and
// is honestly attributed to the agent) plus isAdmin/is_admin so the registry's
// admin gate passes without a DB lookup.
const SAM_SYSTEM_USER_ID = 'agent:sam'
const SAM_ADMIN_CTX = Object.freeze({
  isAdmin: true,
  is_admin: true,
  role: 'admin',
  samAuthorised: false,
  userId: SAM_SYSTEM_USER_ID,
  id: SAM_SYSTEM_USER_ID,
  email: (process.env.AGENT_CONTROL_ADMIN_EMAIL
    || process.env.ADMIN_EMAIL
    || 'admin@grantflow.local').trim().toLowerCase(),
})

export class SamAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'sam',
      label: 'Sam',
      tagline: 'Production Readiness / Audit',
    })
  }

  async getStatus({ db } = {}) {
    const base = await super.getStatus({ db })
    let last = null
    try {
      const row = await db
        ?.prepare('SELECT id, status, mode, started_at, completed_at, health_score FROM sam_runs ORDER BY started_at DESC LIMIT 1')
        .get()
      last = row || null
    } catch { /* sam_runs may not exist on bare test DBs */ }
    // Reconcile "last run" with the telemetry timeline: both read the unified
    // agent_activity_events stream. Fall back to the run table on older DBs.
    const lastRunAt = (await getLastRunAtFromEvents(db, 'sam')) || last?.started_at || null
    return {
      ...base,
      installed: true,
      last_run_at: lastRunAt,
      last_status: last?.status || null,
      health: last?.status === 'failed' ? 'error' : last ? 'healthy' : 'idle',
      details: last,
    }
  }

  async start({ db, controlRunId, stepId, options = {}, signal, stage = 'preflight' } = {}) {
    const dryRun = Boolean(options?.dry_run ?? true)
    const runOnPreflight = options?.run_sam_preflight !== false
    const runOnPostflight = options?.run_sam_postflight !== false
    // Owner-attached free-text instruction (see agentControlOrchestrator's
    // consumeDirectives). Sam can't safely infer WHICH checks it narrows to
    // from free text — a wrong guess would silently hide real findings — so
    // it's recorded on the run for visibility rather than used to scope
    // checkIds. Scoping a single check is done deterministically instead, via
    // the finding panel's "Re-check now" (POST /api/sam/run with the exact
    // check id) or the Console's explicit check picker.
    const directive = typeof options?.directives?.sam === 'string' ? options.directives.sam : null

    if (stage === 'preflight' && !runOnPreflight) {
      return { ok: true, status: 'skipped', summary: { agent: 'sam', stage, skipped: true } }
    }
    if (stage === 'postflight' && !runOnPostflight) {
      return { ok: true, status: 'skipped', summary: { agent: 'sam', stage, skipped: true } }
    }

    if (signal?.shouldStop?.()) {
      return { ok: true, status: 'stopped', summary: { agent: 'sam', stage, stopped: true } }
    }

    let runSam
    let makeInternalHttpProbe = () => null
    try {
      ({ runSam } = await import('../../sam/samAgent.js'))
      ;({ makeInternalHttpProbe } = await import('../../sam/samHttpProbe.js'))
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: `Sam not loadable: ${err?.message || err}`,
        summary: { agent: 'sam', stage, error: String(err?.message || err) },
      }
    }

    await signal?.heartbeat?.({ stage, started: true })

    let result
    try {
      result = await runSam({
        db,
        ctx: { ...SAM_ADMIN_CTX },
        mode: 'observe',
        trigger: 'admin-ui',
        dryRun,
        persist: true,
        // Credentialed loopback probe so the Control-Center run actually
        // executes Sam's HTTP-class checks instead of fail-skipping them.
        httpProbe: makeInternalHttpProbe(),
        operatorNote: directive || undefined,
      })
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: String(err?.message || err),
        summary: { agent: 'sam', stage, error: String(err?.message || err) },
      }
    }

    const findings = Array.isArray(result?.findings) ? result.findings : []
    const critical = findings.filter((f) => f?.severity === 'critical').length
    const high = findings.filter((f) => f?.severity === 'high').length
    const productionReady = result?.production_ready !== false

    await signal?.recordEvent?.({
      eventType: 'agent.sam.completed',
      severity: critical > 0 ? 'critical' : high > 0 ? 'high' : 'info',
      message: `Sam ${stage} ${result?.status || 'completed'} (score ${result?.health_score ?? 'n/a'})`,
      data: {
        sam_run_id: result?.run_id || null,
        stage,
        critical_findings: critical,
        high_findings: high,
        production_ready: productionReady,
      },
    })

    const stopOnCritical = options?.stop_on_critical_sam_finding !== false
    if (stage === 'preflight' && stopOnCritical && critical > 0) {
      return {
        ok: true,
        status: 'blocked',
        summary: {
          agent: 'sam',
          stage,
          critical_findings: critical,
          high_findings: high,
          production_ready: productionReady,
          sam_run_id: result?.run_id || null,
        },
        blocked_reason: `Sam preflight reported ${critical} critical finding(s); stop_on_critical_sam_finding=true`,
      }
    }

    return {
      ok: result?.ok !== false,
      status: result?.ok === false ? 'failed' : 'completed',
      summary: {
        agent: 'sam',
        stage,
        sam_run_id: result?.run_id || null,
        health_score: result?.health_score ?? null,
        production_ready: productionReady,
        findings_total: findings.length,
        critical_findings: critical,
        high_findings: high,
      },
    }
  }

  async health(args) { return this.getStatus(args) }
}
