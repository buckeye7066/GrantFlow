/**
 * samAgent.js
 *
 * Sam — GrantFlow's production-readiness agent. This module is the
 * orchestrator: it picks a mode, runs the appropriate diagnostics +
 * gates, asks the planner for a repair plan, optionally applies safe
 * fixes (ONLY when the caller is an authorised admin AND mode is
 * `repair-safe`), and persists the run to `sam_runs`.
 *
 * Sam never:
 *   - touches grant-matching, scoring, crawler-persistence, payment,
 *     auth, profile-isolation code (see samSafeFixes.FORBIDDEN_PATH_PATTERNS)
 *   - claims a check passed unless the underlying tool/script said so
 *   - spawns a command that isn't in the whitelist
 *   - returns secrets to the client (everything passes through maskSecrets)
 *
 * Default mode is `observe`: read-only, no plan, no writes.
 */

import {
  DEFAULT_MODE,
  SAM_MODES,
  SAM_RUN_STATUS,
  SAM_TRIGGERS,
  computeHealthScore,
  determineProductionReady,
  isValidMode,
  summariseFindings,
  makeFinding,
  SEVERITY,
  SAM_CATEGORIES,
} from './samTypes.js'
import {
  PRODUCTION_GATE_NODE_SCRIPTS,
  PRODUCTION_GATE_SCRIPTS,
  buildCommandWhitelist,
} from './samRegistry.js'
import { runDiagnostics } from './samDiagnostics.js'
import { planRepairs } from './samRepairPlanner.js'
import {
  applySafeFixes,
  runWhitelistedCommand,
} from './samSafeFixes.js'
import { escalateSamCritical } from './samEscalation.js'
import { gitProposeFixes } from './samGit.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
import {
  completeRun,
  getRun,
  latestRun,
  latestSuccessfulRun,
  latestFailedRun,
  listRuns,
  maskSecrets,
  startRun,
} from './samAuditStore.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run Sam end-to-end.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.ctx                    request context (req.ctx)
 * @param {string} [args.mode]                 'observe'|'advise'|'repair-safe'|'gatekeeper'
 * @param {string} [args.trigger]              'manual'|'scheduled'|'startup'|'admin-ui'|'api'
 * @param {string[]} [args.checkIds]
 * @param {string[]} [args.fixIds]             only consulted in repair-safe
 * @param {boolean} [args.dryRun=true]
 * @param {number} [args.maxFixes=10]
 * @param {Function} [args.invokeTool]
 * @param {Function} [args.httpProbe]
 * @param {Function} [args.runCommand]
 * @param {boolean} [args.persist=true]
 * @returns {Promise<object>} run summary
 */
export async function runSam(args = {}) {
  const {
    db,
    ctx,
    mode: requestedMode = DEFAULT_MODE,
    trigger = SAM_TRIGGERS.MANUAL,
    checkIds = null,
    fixIds = [],
    dryRun = true,
    maxFixes = parseMaxFixes(),
    invokeTool = null,
    httpProbe = null,
    runCommand = runWhitelistedCommand,
    persist = true,
  } = args

  const mode = isValidMode(requestedMode) ? String(requestedMode).toLowerCase() : DEFAULT_MODE
  const failOnCritical = readEnvBool('SAM_FAIL_ON_CRITICAL', true)

  // ----- Authorisation gate ------------------------------------------------
  // Sam never writes a single byte unless the caller is an authorised admin
  // AND the mode is `repair-safe`. Even `gatekeeper` is read-only.
  const authorisedByAdmin = Boolean(ctx?.isAdmin) || Boolean(ctx?.samAuthorised)
  if (mode === SAM_MODES.REPAIR_SAFE && (!authorisedByAdmin || dryRun)) {
    // Downgrade to advise so we still produce a useful report instead of
    // refusing outright. We mark the downgrade in the summary so admins
    // see why.
    return runSam({
      ...args,
      mode: SAM_MODES.ADVISE,
      trigger,
      _downgradedFromRepair: { authorisedByAdmin, dryRun },
    })
  }

  let runId = null
  if (persist && db) {
    try {
      runId = await startRun(db, {
        mode,
        trigger,
        created_by_user_id: ctx?.userId ?? null,
      })
    } catch (err) {
      console.warn('[sam] startRun failed; continuing without persistence:', err?.message || err)
    }
  }

  const findings = []
  const checkResults = []
  const gateResults = []
  const appliedFixes = []
  let runError = null

  try {
    // ---------- Diagnostics (every mode runs these) -----------------------
    const diag = await runDiagnostics({
      db,
      ctx,
      checkIds,
      invokeTool,
      httpProbe,
    })
    findings.push(...diag.findings)
    checkResults.push(...diag.results)

    // ---------- Production gates (gatekeeper only) -------------------------
    if (mode === SAM_MODES.GATEKEEPER) {
      const gates = await runProductionGates({ runCommand })
      gateResults.push(...gates)
      for (const g of gates) {
        if (g.status === 'skipped') continue
        if (!g.ok) {
          findings.push(makeFinding({
            severity: g.severity || SEVERITY.HIGH,
            category: g.category || SAM_CATEGORIES.BUILD_INTEGRITY,
            title: `Gate failed: ${g.label}`,
            description: g.skipped
              ? `Skipped: ${g.skipped_reason || 'unknown'}`
              : `Command \`${g.command}\` exited ${g.status_code} after ${g.duration_ms}ms.`,
            evidence: {
              command: g.command,
              status: g.status_code,
              tail_stdout: g.stdout_tail,
              tail_stderr: g.stderr_tail,
            },
            recommended_fix: `Run \`${g.command}\` locally and triage the failure.`,
            confidence: 0.95,
          }))
        }
      }
    }

    // ---------- Repair plan (advise / repair-safe) ------------------------
    let repairPlan = []
    if (mode === SAM_MODES.ADVISE || mode === SAM_MODES.REPAIR_SAFE) {
      repairPlan = planRepairs(findings)
    }

    // ---------- Safe fixes (repair-safe only) -----------------------------
    if (mode === SAM_MODES.REPAIR_SAFE && Array.isArray(fixIds) && fixIds.length > 0) {
      const fixes = await applySafeFixes({
        fixIds,
        context: { authorisedByAdmin, mode },
        maxFixes,
      })
      appliedFixes.push(...fixes)
    }

    const score = computeHealthScore(findings)
    const productionReady = determineProductionReady(findings, { failOnCritical })

    const summary = {
      agent: 'Sam',
      purpose: 'production_readiness',
      mode,
      trigger,
      dryRun,
      authorisedByAdmin,
      ranAt: new Date().toISOString(),
      checks_run: checkResults.length,
      gates_run: gateResults.length,
      findings: summariseFindings(findings),
      health_score: score,
      production_ready: productionReady,
      gate_results: gateResults.map((g) => ({
        label: g.label,
        ok: g.ok,
        status: g.status,
        skipped: g.skipped === true,
        skipped_reason: g.skipped_reason || null,
        duration_ms: g.duration_ms,
      })),
      _downgradedFromRepair: args._downgradedFromRepair || null,
    }

    const out = {
      ok: true,
      run_id: runId,
      status: SAM_RUN_STATUS.COMPLETED,
      mode,
      health_score: score,
      production_ready: productionReady,
      findings,
      repair_plan: repairPlan,
      applied_fixes: appliedFixes,
      gate_results: gateResults,
      check_results: checkResults,
      summary,
    }

    if (persist && db && runId) {
      await completeRun(db, runId, {
        status: SAM_RUN_STATUS.COMPLETED,
        health_score: score,
        production_ready: productionReady,
        summary,
        findings,
        repair_plan: repairPlan,
        applied_fixes: appliedFixes,
      })

      // Charter §3/§6: push critical findings to the canonical admin. Fires only
      // on critical findings; best-effort, never affects the run result.
      try {
        out.escalation = await escalateSamCritical(db, {
          runId,
          findingSummary: summary.findings,
          healthScore: score,
          productionReady,
        })
      } catch (escErr) {
        console.warn('[sam] admin escalation skipped:', escErr?.message || escErr)
      }

      // Charter §6: if any safe fixes were applied AND policy allows, put them on
      // a dedicated branch (+ PR) — never on main. Default OFF (auto_commit_allowed
      // false), gated by assertCommitAllowed inside gitProposeFixes. Best-effort.
      if (appliedFixes.some((f) => f?.applied === true)) {
        try {
          out.git_proposal = await gitProposeFixes(db, { runId, appliedFixes })
        } catch (gitErr) {
          console.warn('[sam] git proposal skipped:', gitErr?.message || gitErr)
        }
      }
    }

    return out
  } catch (err) {
    runError = err
    const score = computeHealthScore(findings)
    const summary = {
      agent: 'Sam',
      mode,
      trigger,
      crashed: true,
      error: maskSecrets(String(err?.message || err)),
    }
    if (persist && db && runId) {
      try {
        await completeRun(db, runId, {
          status: SAM_RUN_STATUS.FAILED,
          health_score: score,
          production_ready: false,
          summary,
          findings,
          repair_plan: [],
          applied_fixes: appliedFixes,
          error: String(err?.message || err),
        })
      } catch (persistErr) {
        console.error('[sam] failed to persist crash:', persistErr?.message || persistErr)
      }
    }
    return {
      ok: false,
      run_id: runId,
      status: SAM_RUN_STATUS.FAILED,
      mode,
      health_score: score,
      production_ready: false,
      findings,
      repair_plan: [],
      applied_fixes: appliedFixes,
      summary,
      error: maskSecrets(String(err?.message || err)),
    }
  } finally {
    if (runError) console.warn('[sam] run completed with error:', runError?.message || runError)
  }
}

// ---------------------------------------------------------------------------
// Production-gate runner
// ---------------------------------------------------------------------------
export async function runProductionGates({ runCommand = runWhitelistedCommand } = {}) {
  const whitelist = buildCommandWhitelist()
  const gates = []
  for (const gate of PRODUCTION_GATE_SCRIPTS) {
    const command = `npm run -s ${gate.script}`
    const start = Date.now()
    const result = await runCommand(command, { whitelist })
    gates.push(formatGate({ ...gate, label: `npm run ${gate.script}`, command }, result, Date.now() - start))
  }
  for (const gate of PRODUCTION_GATE_NODE_SCRIPTS) {
    const command = `node ${gate.file}`
    const start = Date.now()
    if (!fileExists(gate.file)) {
      gates.push(formatGate(
        { ...gate, label: gate.label, command },
        { ok: true, status: 0, skipped: true, skipped_reason: 'script_not_found', stdout: '', stderr: '' },
        0,
      ))
      continue
    }
    const result = await runCommand(command, { whitelist })
    gates.push(formatGate({ ...gate, label: gate.label, command }, result, Date.now() - start))
  }
  return gates
}

function formatGate(gate, result, duration_ms) {
  return {
    check: gate.script || gate.file || gate.label,
    label: gate.label,
    command: gate.command,
    category: gate.category,
    severity: gate.severityOnFailure,
    status: result.skipped ? 'skipped' : (result.ok ? 'passed' : 'failed'),
    ok: result.skipped ? true : Boolean(result.ok),
    skipped: result.skipped === true,
    skipped_reason: result.skipped_reason || null,
    status_code: result.status,
    timed_out: Boolean(result.timed_out),
    duration_ms,
    stdout_tail: tail(result.stdout, 4_000),
    stderr_tail: tail(result.stderr, 4_000),
  }
}

function tail(str, n) {
  if (!str) return ''
  return String(str).slice(-n)
}

function fileExists(rel) {
  try {
    return fs.existsSync(path.join(REPO_ROOT, rel))
  } catch { return false }
}

// ---------------------------------------------------------------------------
// Status snapshot — fast path for /api/sam/status
// ---------------------------------------------------------------------------
export async function getSamStatus({ db } = {}) {
  const enabled = readEnvBool('SAM_ENABLED', false)
  const allowSafeRepair = readEnvBool('SAM_ALLOW_SAFE_REPAIR', false)
  const runOnSchedule = readEnvBool('SAM_RUN_ON_SCHEDULE', false)
  const runOnStartup = readEnvBool('SAM_RUN_ON_STARTUP', false)
  const mode = (process.env.SAM_MODE || DEFAULT_MODE).toLowerCase()
  const schedule = process.env.SAM_SCHEDULE || '0 4 * * *'
  const maxFixes = parseMaxFixes()
  const failOnCritical = readEnvBool('SAM_FAIL_ON_CRITICAL', true)

  const status = {
    agent: 'Sam',
    purpose: 'production_readiness',
    mode,
    enabled,
    allow_safe_repair: allowSafeRepair,
    run_on_startup: runOnStartup,
    run_on_schedule: runOnSchedule,
    schedule,
    max_fixes_per_run: maxFixes,
    fail_on_critical: failOnCritical,
    running: false,
    last_run: null,
    last_run_at: null,
    last_success_at: null,
    last_failure_at: null,
    health_score: null,
    production_ready: null,
    open_findings_count: 0,
    critical_findings_count: 0,
    warnings_count: 0,
    checks: defaultChecksRollup(),
  }

  if (!db) return status

  const last = await latestRun(db).catch(() => null)
  const lastSuccess = await latestSuccessfulRun(db).catch(() => null)
  const lastFailure = await latestFailedRun(db).catch(() => null)

  if (last) {
    status.last_run = {
      id: last.id,
      mode: last.mode,
      status: last.status,
      started_at: last.started_at,
      completed_at: last.completed_at,
    }
    status.last_run_at = last.started_at
    status.health_score = last.health_score
    status.production_ready = last.production_ready
    const findingSummary = summariseFindings(last.findings)
    status.open_findings_count = findingSummary.total
    status.critical_findings_count = findingSummary.critical
    status.warnings_count = findingSummary.high + findingSummary.medium
    status.checks = rollupChecks(last)
    status.running = last.status === SAM_RUN_STATUS.RUNNING
  }
  if (lastSuccess) status.last_success_at = lastSuccess.started_at
  if (lastFailure) status.last_failure_at = lastFailure.started_at

  return status
}

function defaultChecksRollup() {
  return {
    lint: 'unknown',
    typecheck: 'unknown',
    unit: 'unknown',
    build: 'unknown',
    migrations: 'unknown',
    release_gates: 'unknown',
    smoke: 'unknown',
    healthz: 'unknown',
    readyz: 'unknown',
    api_routes: 'unknown',
    frontend_buttons: 'unknown',
    profile_scope: 'unknown',
    safe_sql: 'unknown',
    runtime_imports: 'unknown',
    auth_guards: 'unknown',
    crawler_health: 'unknown',
  }
}

function rollupChecks(run) {
  const out = defaultChecksRollup()
  const summary = run?.summary || {}
  const map = {
    'npm run lint:strict': 'lint',
    'npm run typecheck':   'typecheck',
    'npm run unit':        'unit',
    'npm run build':       'build',
    'npm run db:setup':    'migrations',
    'npm run release:gates': 'release_gates',
    'npm run crawler:smoke': 'smoke',
    'npm run smoke:apply-engine': 'smoke',
  }
  for (const g of (summary.gate_results || [])) {
    const key = map[g.label] || null
    if (key) out[key] = g.skipped ? 'skipped' : g.ok ? 'pass' : 'fail'
  }
  // Diagnostic checks → status fields
  for (const f of (run?.findings || [])) {
    if (f?.affected_routes?.includes('/readyz')) out.readyz = 'fail'
    if (f?.affected_routes?.includes('/healthz')) out.healthz = 'fail'
    if (f?.category === SAM_CATEGORIES.PROFILE_ISOLATION) out.profile_scope = 'fail'
    if (f?.category === SAM_CATEGORIES.SQL_SAFETY) out.safe_sql = 'fail'
    if (f?.category === SAM_CATEGORIES.AUTH_AND_ADMIN_GUARDS) out.auth_guards = 'fail'
    if (f?.category === SAM_CATEGORIES.CRAWLER_RELIABILITY) out.crawler_health = 'fail'
    if (f?.category === SAM_CATEGORIES.BROKEN_IMPORTS) out.runtime_imports = 'fail'
    if (f?.category === SAM_CATEGORIES.ROUTE_INTEGRITY) out.api_routes = 'fail'
    if (f?.category === SAM_CATEGORIES.UI_ACTION_WIRING) out.frontend_buttons = 'fail'
  }
  return out
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export {
  getRun,
  listRuns,
  latestRun,
  latestSuccessfulRun,
  latestFailedRun,
  maskSecrets,
}

// ---------------------------------------------------------------------------
// env helpers
// ---------------------------------------------------------------------------
function readEnvBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

function parseMaxFixes() {
  const n = Number(process.env.SAM_MAX_FIXES_PER_RUN)
  if (Number.isFinite(n) && n > 0) return Math.min(50, Math.floor(n))
  return 10
}

export const __testing__ = { readEnvBool, parseMaxFixes, formatGate, rollupChecks }
