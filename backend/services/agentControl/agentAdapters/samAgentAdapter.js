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
 *
 * THE PREFLIGHT GATE NAMES ITS PREREQUISITE (prodready issue 5, 2026-09-12).
 * Production carried 45 of 104 sam_preflight steps in 30 days ended 'blocked'
 * with the count-only reason "Sam preflight reported 1 critical finding(s)".
 * Every one of them was '/readyz returned 503 (expected 200)' whose body was
 * {reason:'mission_gate_failed', release_blockers:[
 * 'release_catalog_verified_pct_below_target',
 * 'visible_direct_link_requirement_failed']} — an INTENTIONAL release-gate
 * block (do not run the fleet on a system whose release gate is red) whose
 * durable status named nothing: no check id, no readyz reason, no blocker
 * code, no operator action. `evaluateSamPreflight` below is the ONE place the
 * block decision is made, and it always returns the named prerequisites and
 * the concrete operator action alongside the decision. The gate itself is not
 * weakened: a critical finding still blocks; stop_on_critical_sam_finding still
 * defaults to true.
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

// Reason string samDiagnostics.runHttpCheck records on a check it could not
// execute because no loopback probe exists. Kept as a literal here (rather
// than importing samDiagnostics → samRegistry into the adapter registry's
// boot path); backend/tests/samPreflightGate.test.js pins the two equal.
export const HTTP_PROBE_UNAVAILABLE = 'http_probe_unavailable'

// The two always-on CRITICAL checks (samRegistry.defaultDiagnosticIds) are
// both HTTP-kind. Route → check id lets a LEGACY finding (persisted before
// findings carried check_id/event_type) still be attributed.
const CRITICAL_ROUTE_CHECK_IDS = Object.freeze({
  '/readyz': 'http.readyz',
  '/api/hamilton/automation/payment-authorizations': 'agent.hamilton.security',
})

// ---------------------------------------------------------------------------
// Operator-action tables. One entry per prerequisite code the preflight can
// name. Every action is CONCRETE (an endpoint to read, an env var to set, a
// command to run) — a code without an action is the count-only status again.
// ---------------------------------------------------------------------------
const VERIFY_LINKS_ACTION = 'the recurring link verifier now prioritises the visible catalog (fix shipped 2026-09-12) — let it drain, or run it manually: POST /api/admin/verify-links (x-admin-token)'

export const MISSION_BLOCKER_ACTIONS = Object.freeze({
  release_catalog_verified_pct_below_target: {
    detail: 'Release gate: fresh link verification covers less than 95% of the visible catalog.',
    operator_action: `Link freshness below 95%: inspect GET /api/health/mission release_catalog (verified_pct vs target_pct); ${VERIFY_LINKS_ACTION}`,
  },
  visible_direct_link_requirement_failed: {
    detail: 'Release gate: one or more visible direct opportunities lack fresh link verification (every visible direct opportunity must meet the link requirement).',
    operator_action: `Visible direct opportunities lack fresh verification (count: GET /api/health/mission release_catalog.visible_direct.unverified_or_stale): same verifier — ${VERIFY_LINKS_ACTION}`,
  },
  verified_pct_below_target: {
    detail: 'Release gate: verified share of direct opportunities is below the 95% target.',
    operator_action: `Verified share below target: inspect GET /api/health/mission rates.verified_pct; ${VERIFY_LINKS_ACTION}`,
  },
  broken_pct_above_target: {
    detail: 'Release gate: broken-link share of direct opportunities is above the 5% ceiling.',
    operator_action: `Broken-link share above 5%: inspect GET /api/health/mission rates.broken_pct and link_lifecycle buckets; repair/quarantine via POST /api/admin/verify-links`,
  },
  crawler_source_outcomes_stale: {
    detail: 'Release gate: no crawler source outcomes were recorded within the freshness window (48h).',
    operator_action: 'Crawler source outcomes are stale: check the crawler scheduler and crawler_source_runs; start a discovery run (POST /api/real-crawlers/run-smart) and confirm outcomes land.',
  },
  placeholder_opportunities_present: {
    detail: 'Release gate: placeholder opportunities exist in the catalog.',
    operator_action: 'Placeholder opportunities present: inspect GET /api/health/mission counts.placeholder_opportunities and purge or repair those rows.',
  },
  release_catalog_snapshot_unavailable: {
    detail: 'Release gate: the release-catalog snapshot query failed.',
    operator_action: 'Release catalog snapshot unavailable: read GET /api/health/mission release_catalog.error and check database connectivity/schema.',
  },
  link_lifecycle_partition_mismatch: {
    detail: 'Release gate: link lifecycle buckets do not reconcile to the catalog total.',
    operator_action: 'Link lifecycle partition mismatch: inspect GET /api/health/mission link_lifecycle (buckets vs partition_total) and repair the drifted rows.',
  },
  pii_external_query_violation: {
    detail: 'Release gate: an external query carried PII.',
    operator_action: 'PII in an external query: read GET /api/health/mission alerts for the offending lane and fix the query builder before re-running discovery.',
  },
  unmapped_profile_fields: {
    detail: 'Release gate: profile fields exist that no matcher/crawler consumes.',
    operator_action: 'Unmapped profile fields: read GET /api/health/mission alerts and map each named field (profileSchema → matcher/crawler usage).',
  },
  field_usage_references_unknown_source: {
    detail: 'Release gate: field-usage metadata references a source that does not exist.',
    operator_action: 'Field usage references an unknown source: read GET /api/health/mission alerts and correct the source id in the field-usage registry.',
  },
  profile_types_below_source_minimum: {
    detail: 'Release gate: some profile types have fewer sources than the declared minimum.',
    operator_action: 'Profile types below source minimum: read GET /api/health/mission alerts for the named types and add/enable sources in samRegistry/sourceRegistry.',
  },
  mission_service_not_globally_integrated: {
    detail: 'Release gate: the mission service is not wired into every required surface.',
    operator_action: 'Mission service not globally integrated: read GET /api/health/mission alerts and wire the named surface.',
  },
})

function missionBlockerPrerequisite(code) {
  const known = MISSION_BLOCKER_ACTIONS[code]
  if (known) return { code, detail: known.detail, operator_action: known.operator_action }
  return {
    code,
    detail: `Release gate blocker ${code} reported by GET /readyz (mission_gate_failed).`,
    operator_action: `Release blocker ${code}: inspect GET /api/health/mission release_blockers[].detail (x-admin-token) and clear it.`,
  }
}

function readyzReasonOperatorAction(reason) {
  const r = String(reason || '')
  if (/^db_/.test(r)) return `Database readiness failed (/readyz reason ${r}): check DATABASE_URL and database connectivity from the app host, then re-probe GET /readyz.`
  if (/^boot_migration/.test(r)) return `Boot migrations did not complete (/readyz reason ${r}): read the startup migration log, run the pending migrations (npm run migrate) against the deployed database, and redeploy.`
  if (r === 'missing_schema' || r === 'schema_check_failed' || /^invalid_(table|column)_identifier$/.test(r) || r === 'application_task_status_constraint_invalid') {
    return `Required schema is missing or out of date (/readyz reason ${r}): run the pending migrations (npm run migrate) and redeploy.`
  }
  if (r === 'missing_auth_jwt_secret' || r === 'insecure_auth_jwt_secret') return `Set a strong AUTH_JWT_SECRET (32+ random characters) in the server environment and restart (/readyz reason ${r}).`
  if (r === 'uploads_unwritable') return 'Uploads directory is not writable: check the UPLOADS_DIR volume mount and permissions, then re-probe GET /readyz.'
  if (r === 'malware_scanner_required_but_unconfigured') return 'Malware scanner required but not configured: set the upload scanner environment (CLAMAV_*) or relax the requirement for this environment.'
  return `GET /readyz reports ${r}: read the /readyz response body and fix the named readiness failure before running the fleet.`
}

const LOOPBACK_UNREACHABLE_ACTION = 'The loopback probe to 127.0.0.1:PORT was refused or timed out: confirm the server is listening on PORT (and only PORT) and raise SAM_HTTP_PROBE_TIMEOUT_MS if the host is slow.'

// ---------------------------------------------------------------------------
// Finding attribution helpers (pure)
// ---------------------------------------------------------------------------
function parseJsonObject(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function blockerCodes(list) {
  if (!Array.isArray(list)) return null
  const codes = list
    .map((item) => (typeof item === 'string' ? item : item?.code))
    .filter((code) => typeof code === 'string' && code.length > 0)
  return codes
}

/** Lift HTTP status + readyz reason + release_blockers from a finding (new or legacy shape). */
export function extractHttpEvidence(finding) {
  const evidence = finding?.evidence && typeof finding.evidence === 'object' ? finding.evidence : {}
  let status = Number.isFinite(Number(evidence.status)) && evidence.status !== null && evidence.status !== undefined
    ? Number(evidence.status)
    : null
  if (status === null) {
    const m = /returned (\d+)/.exec(String(finding?.title || ''))
    if (m) status = Number(m[1])
  }
  const body = parseJsonObject(finding?.description)
  const reason = typeof evidence.body_reason === 'string' && evidence.body_reason
    ? evidence.body_reason
    : (typeof body?.reason === 'string' && body.reason ? body.reason : null)
  const blockers = Array.isArray(evidence.release_blockers)
    ? blockerCodes(evidence.release_blockers)
    : blockerCodes(body?.release_blockers)
  return { status, reason, release_blockers: blockers }
}

function inferCheckId(finding) {
  if (typeof finding?.check_id === 'string' && finding.check_id) return finding.check_id
  if (typeof finding?.event_type === 'string' && finding.event_type) return finding.event_type
  const routes = Array.isArray(finding?.affected_routes) ? finding.affected_routes : []
  for (const route of routes) {
    if (CRITICAL_ROUTE_CHECK_IDS[route]) return CRITICAL_ROUTE_CHECK_IDS[route]
  }
  return null
}

/** Compact, JSON-safe description of one critical finding for the blocked detail. */
export function describeCriticalFinding(finding) {
  const http = extractHttpEvidence(finding)
  return {
    check_id: inferCheckId(finding),
    finding_id: typeof finding?.id === 'string' ? finding.id : null,
    title: String(finding?.title || ''),
    affected_routes: Array.isArray(finding?.affected_routes) ? finding.affected_routes.slice(0, 10) : [],
    description_excerpt: String(finding?.description || '').slice(0, 240),
    http_status: http.status,
    readyz_reason: http.reason,
    release_blockers: http.release_blockers,
  }
}

/** Map one described critical finding to the prerequisite(s) it proves unmet. */
export function prerequisitesForCriticalFinding(c) {
  const status = c?.http_status
  const route = c?.affected_routes?.[0] || null
  if (c?.check_id === 'http.readyz') {
    if (status === 0) {
      return [{
        code: 'loopback_unreachable',
        detail: `GET /readyz got no response (status 0): ${c.description_excerpt || 'probe failed'}`,
        operator_action: LOOPBACK_UNREACHABLE_ACTION,
      }]
    }
    if (c.readyz_reason === 'mission_gate_failed') {
      const codes = Array.isArray(c.release_blockers) ? c.release_blockers : []
      if (codes.length === 0) {
        return [{
          code: 'mission_gate_failed',
          detail: 'GET /readyz returned 503 mission_gate_failed with no release_blockers listed.',
          operator_action: 'Inspect GET /api/health/mission release_blockers (x-admin-token) and clear each listed blocker.',
        }]
      }
      return codes.map((code) => ({
        ...missionBlockerPrerequisite(code),
        detail: `GET /readyz 503 mission_gate_failed — release blocker ${code}. ${missionBlockerPrerequisite(code).detail}`,
      }))
    }
    if (c.readyz_reason) {
      return [{
        code: c.readyz_reason,
        detail: `GET /readyz returned ${status ?? 'non-200'} with reason ${c.readyz_reason}.`,
        operator_action: readyzReasonOperatorAction(c.readyz_reason),
      }]
    }
    return [{
      code: `readyz_${status ?? 'unknown'}`,
      detail: `GET /readyz returned ${status ?? 'non-200'} (expected 200): ${c.description_excerpt}`,
      operator_action: 'Read the GET /readyz response body and fix the named readiness failure before running the fleet.',
    }]
  }
  if (c?.check_id === 'agent.hamilton.security') {
    const path = route || '/api/hamilton/automation/payment-authorizations'
    if (status === 401 || status === 403) {
      return [{
        code: 'probe_unauthenticated',
        detail: `GET ${path} returned ${status}: the loopback probe was not recognised as admin (x-admin-token missing or does not match).`,
        operator_action: 'loopback probe not authenticated: set ADMIN_TOKEN (or ANYA_ADMIN_TOKEN) in the server environment so Sam\'s x-admin-token header matches the server\'s configured token; this status does not by itself prove the Hamilton payment guard is broken.',
      }]
    }
    if (status === 404) {
      return [{
        code: 'hamilton_automation_not_mounted',
        detail: `GET ${path} returned 404: the Hamilton automation router is not mounted.`,
        operator_action: 'Hamilton automation routes are not mounted: check backend/server.js mounts /api/hamilton/automation (requireHamiltonPipelineAutomation + hamiltonAutomation router) and redeploy.',
      }]
    }
    if (status === 0) {
      return [{
        code: 'loopback_unreachable',
        detail: `GET ${path} got no response (status 0): ${c.description_excerpt || 'probe failed'}`,
        operator_action: LOOPBACK_UNREACHABLE_ACTION,
      }]
    }
    return [{
      code: 'hamilton_automation_error',
      detail: `GET ${path} returned ${status ?? 'non-200'} (expected 200 or 400): ${c.description_excerpt}`,
      operator_action: `The Hamilton payment-authorization guard returned ${status ?? 'an error'}: read the server log for ${path} and fix the handler before running the fleet.`,
    }]
  }
  const checkId = c?.check_id || 'unknown'
  return [{
    code: `sam_critical:${checkId}`,
    detail: c?.title || 'critical Sam finding',
    operator_action: `Open GET /api/sam/runs/<sam_run_id> for the finding "${c?.title || ''}" and resolve it; re-check deterministically with POST /api/sam/run {"checks":["${checkId}"]}.`,
  }]
}

/** Every CRITICAL-class check that was skipped because no loopback probe existed. */
export function collectSkippedCriticalChecks(checkResults) {
  if (!Array.isArray(checkResults)) return []
  return checkResults
    .filter((r) => r && r.skipped === true && r.reason === HTTP_PROBE_UNAVAILABLE && r.severity_on_failure === 'critical')
    .map((r) => ({ check_id: r.check_id || null, reason: HTTP_PROBE_UNAVAILABLE }))
}

function dedupePrerequisites(list) {
  const seen = new Set()
  const out = []
  for (const p of list) {
    if (!p || !p.code || seen.has(p.code)) continue
    seen.add(p.code)
    out.push({ code: p.code, detail: String(p.detail || ''), operator_action: String(p.operator_action || '') })
  }
  return out
}

function describeProbeUnavailable(probe) {
  if (probe && typeof probe.detail === 'string' && probe.detail) return probe.detail
  if (probe && typeof probe.reason === 'string' && probe.reason) return `loopback probe unavailable (${probe.reason})`
  return 'loopback probe unavailable (PORT unset or not a listening port)'
}

/**
 * THE canonical preflight block decision. Pure — no I/O, no env reads beyond
 * the `nodeEnv` handed in — so it is testable without a server.
 *
 * @param {object} args
 * @param {object[]} args.findings       Sam findings from runSam
 * @param {object[]} args.checkResults   runSam.check_results (per-check detail)
 * @param {boolean}  [args.stopOnCritical=true]  options.stop_on_critical_sam_finding !== false
 * @param {object}   [args.probe]        describeInternalHttpProbe() output ({available, reason, detail})
 * @param {string}   [args.nodeEnv]      NODE_ENV — 'production' makes a missing probe BLOCK
 * @returns {{
 *   blocked: boolean,
 *   blocked_reason: string|null,
 *   blocked_detail: null | { critical_findings: object[], prerequisites: object[], skipped_critical_checks: object[], sam_run_id: string|null },
 *   critical_findings: object[],
 *   skipped_critical_checks: object[],
 *   prerequisites: object[],
 * }}
 */
export function evaluateSamPreflight({
  findings = [],
  checkResults = [],
  stopOnCritical = true,
  probe = null,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  const criticals = (Array.isArray(findings) ? findings : [])
    .filter((f) => f?.severity === 'critical')
    .map(describeCriticalFinding)
  const skipped = collectSkippedCriticalChecks(checkResults)
  const isProduction = String(nodeEnv || '').toLowerCase() === 'production'

  const prereqs = []
  for (const c of criticals) prereqs.push(...prerequisitesForCriticalFinding(c))
  if (skipped.length > 0) {
    const probeDetail = describeProbeUnavailable(probe)
    prereqs.push({
      code: HTTP_PROBE_UNAVAILABLE,
      detail: `${probeDetail}; ${skipped.length} CRITICAL check(s) were never executed: ${skipped.map((s) => s.check_id).join(', ')}.`,
      operator_action: 'Set PORT to the port this server listens on (and ADMIN_TOKEN/ANYA_ADMIN_TOKEN so the probe is authenticated) so Sam can probe /readyz and the Hamilton payment guard over loopback; until then the CRITICAL checks run vacuously.',
    })
  }
  const prerequisites = dedupePrerequisites(prereqs)

  const blockedByCritical = stopOnCritical && criticals.length > 0
  // sam-preflight-4: in production a preflight that could not execute its
  // CRITICAL checks must not clear the fleet on a vacuous pass. In test/smoke
  // (PORT='0' by design) the skip is RECORDED, not blocking.
  const blockedBySkip = stopOnCritical && isProduction && skipped.length > 0
  const blocked = blockedByCritical || blockedBySkip

  let blockedReason = null
  if (blocked) {
    const parts = []
    if (criticals.length > 0) {
      const named = criticals.map((c) => {
        let s = `${c.check_id || 'unknown-check'} "${c.title}"`
        if (c.readyz_reason) {
          s += ` [readyz reason=${c.readyz_reason}`
          if (Array.isArray(c.release_blockers) && c.release_blockers.length) s += `; release_blockers=${c.release_blockers.join(', ')}`
          s += ']'
        } else if (c.http_status !== null && c.http_status !== undefined && !/returned \d+/.test(c.title)) {
          s += ` [status=${c.http_status}]`
        }
        return s
      })
      parts.push(`${criticals.length} critical finding(s): ${named.join('; ')}`)
    }
    if (skipped.length > 0) {
      parts.push(`${skipped.length} CRITICAL check(s) not executed (${HTTP_PROBE_UNAVAILABLE}: ${describeProbeUnavailable(probe)}): ${skipped.map((s) => s.check_id).join(', ')}${criticals.length === 0 ? ' — a preflight that checked nothing cannot clear the fleet in production' : ''}`)
    }
    parts.push(`Unmet prerequisites: ${prerequisites.map((p) => `${p.code} → ${p.operator_action}`).join(' | ')}`)
    blockedReason = `${parts.join('. ')}. stop_on_critical_sam_finding=true`
  }

  return {
    blocked,
    blocked_reason: blockedReason,
    blocked_detail: blocked
      ? { critical_findings: criticals, prerequisites, skipped_critical_checks: skipped, sam_run_id: null }
      : null,
    critical_findings: criticals,
    skipped_critical_checks: skipped,
    prerequisites,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)

export class SamAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} [deps]  Injection seams (tests / harnesses). Production
   *   constructs with no arguments and resolves everything lazily.
   * @param {Function} [deps.runSam]      replaces the dynamic import of samAgent.runSam
   * @param {Function|null} [deps.httpProbe]  an explicit probe (or explicit null =
   *   "no probe available") instead of makeInternalHttpProbe()
   * @param {object} [deps.probeAvailability]  describeInternalHttpProbe()-shaped
   *   override; defaults to describeInternalHttpProbe({ env })
   * @param {object} [deps.env]          env object (defaults to process.env)
   */
  constructor(deps = {}) {
    super({
      name: 'sam',
      label: 'Sam',
      tagline: 'Production Readiness / Audit',
    })
    this.deps = deps && typeof deps === 'object' ? deps : {}
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

  /** Resolve runSam + the loopback probe (injected or real). */
  async resolveDependencies() {
    const env = this.deps.env && typeof this.deps.env === 'object' ? this.deps.env : process.env
    let runSam = typeof this.deps.runSam === 'function' ? this.deps.runSam : null
    let makeInternalHttpProbe = null
    let describeInternalHttpProbe = null
    if (!runSam) {
      ({ runSam } = await import('../../sam/samAgent.js'))
    }
    if (!hasOwn(this.deps, 'httpProbe') || !this.deps.probeAvailability) {
      ;({ makeInternalHttpProbe, describeInternalHttpProbe } = await import('../../sam/samHttpProbe.js'))
    }
    let httpProbe
    let probeAvailability
    if (hasOwn(this.deps, 'httpProbe')) {
      httpProbe = typeof this.deps.httpProbe === 'function' ? this.deps.httpProbe : null
      probeAvailability = this.deps.probeAvailability
        || (httpProbe
          ? { available: true, reason: null, detail: null }
          : describeInternalHttpProbe({ env }))
    } else {
      httpProbe = makeInternalHttpProbe()
      probeAvailability = this.deps.probeAvailability || describeInternalHttpProbe({ env })
    }
    return { runSam, httpProbe, probeAvailability, env }
  }

  async start({ db, controlRunId, stepId, options = {}, signal, stage = 'preflight' } = {}) {
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
    let httpProbe = null
    let probeAvailability = null
    let env = process.env
    try {
      ({ runSam, httpProbe, probeAvailability, env } = await this.resolveDependencies())
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
        // dry_run is REMOVED from agent-control options (owner no-dry-runs
        // order; this adapter used to DEFAULT it to true, so Control-Center
        // Sam runs did nothing by default). Observe mode is Sam's real
        // read-only auditing work; dryRun:false only stops samAgent's silent
        // repair-safe downgrade from ever engaging on this path.
        dryRun: false,
        persist: true,
        // Credentialed loopback probe so the Control-Center run actually
        // executes Sam's HTTP-class checks instead of fail-skipping them.
        httpProbe,
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
    const checkResults = Array.isArray(result?.check_results) ? result.check_results : []
    const critical = findings.filter((f) => f?.severity === 'critical').length
    const high = findings.filter((f) => f?.severity === 'high').length
    const productionReady = result?.production_ready !== false
    const samRunId = result?.run_id || null

    const stopOnCritical = options?.stop_on_critical_sam_finding !== false
    const decision = evaluateSamPreflight({
      findings,
      checkResults,
      stopOnCritical,
      probe: probeAvailability,
      nodeEnv: env?.NODE_ENV,
    })

    await signal?.recordEvent?.({
      eventType: 'agent.sam.completed',
      severity: critical > 0 ? 'critical' : high > 0 ? 'high' : 'info',
      message: `Sam ${stage} ${result?.status || 'completed'} (score ${result?.health_score ?? 'n/a'})`,
      data: {
        sam_run_id: samRunId,
        stage,
        critical_findings: critical,
        high_findings: high,
        production_ready: productionReady,
        critical_check_ids: decision.critical_findings.map((c) => c.check_id).filter(Boolean),
        skipped_critical_checks: decision.skipped_critical_checks,
      },
    })

    if (stage === 'preflight' && decision.blocked) {
      const blockedDetail = { ...decision.blocked_detail, sam_run_id: samRunId }
      return {
        ok: true,
        status: 'blocked',
        summary: {
          agent: 'sam',
          stage,
          critical_findings: critical,
          high_findings: high,
          production_ready: productionReady,
          sam_run_id: samRunId,
          skipped_critical_checks: decision.skipped_critical_checks,
          blocked_reason: decision.blocked_reason,
          blocked_detail: blockedDetail,
        },
        blocked_reason: decision.blocked_reason,
        blocked_detail: blockedDetail,
      }
    }

    return {
      ok: result?.ok !== false,
      status: result?.ok === false ? 'failed' : 'completed',
      summary: {
        agent: 'sam',
        stage,
        sam_run_id: samRunId,
        health_score: result?.health_score ?? null,
        production_ready: productionReady,
        findings_total: findings.length,
        critical_findings: critical,
        high_findings: high,
        // Named even when not blocking (postflight, gate disabled, test env)
        // so a critical is never reduced to a count anywhere downstream.
        critical_finding_details: decision.critical_findings,
        skipped_critical_checks: decision.skipped_critical_checks,
        prerequisites: decision.prerequisites,
      },
    }
  }

  async health(args) { return this.getStatus(args) }
}
