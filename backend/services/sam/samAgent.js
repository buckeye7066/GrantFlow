/**
 * samAgent.js
 *
 * Sam — GrantFlow's production-readiness agent. This module is the
 * orchestrator: it picks a mode, runs the appropriate diagnostics +
 * gates, asks the planner for a repair plan, optionally applies safe
 * fixes (ONLY when the caller is an authorised admin AND mode is
 * `repair-safe`), and persists the run to `sam_runs`.
 *
 * Evolved mission (2026-07): Sam is the keeper of the self-improvement
 * loop's RATCHETS — the nightly sweep asserts golden outcomes
 * (coverage.goldenOutcomes), gap-scoreboard freshness
 * (coverage.gapScoreboard), web-parity non-regression
 * (coverage.webParityBenchmark), and invariant sweep outcomes. A ratchet
 * regression is a red finding, never a trend line, and every finding
 * carries a recommended_fix. See docs/AGENTS.md + canonical_rules.md
 * "The self-improvement loop".
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
  deriveSafeFixesFromFindings,
  runWhitelistedCommand,
} from './samSafeFixes.js'
import { escalateSamCritical } from './samEscalation.js'
import { sendSamReportEmail } from './samEmailReport.js'
import {
  consumeMeshInbox,
  readMeshLessons,
  recordMeshLesson,
  postMeshMessage,
  markMeshLessonConsumed,
} from '../agentMesh/agentMeshStore.js'
import { gitProposeFixes } from './samGit.js'
import { runAdversarialRepairs } from './samAdversarialRepair.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:sam:samAgent')

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
// Agent mesh (awareness/communication/learning between the resident agents)
// ---------------------------------------------------------------------------

/** Default agent-mesh surface (injectable for tests via runSam args.mesh). */
export const DEFAULT_MESH = Object.freeze({
  consumeInbox: consumeMeshInbox,
  readLessons: readMeshLessons,
  recordLesson: recordMeshLesson,
  postMessage: postMeshMessage,
  markConsumed: markMeshLessonConsumed,
})

/**
 * Run-start consumption: drain Sam's inbox and surface fresh peer lessons Sam
 * has not yet consumed as INFO findings in this sweep — that is how Amy's
 * persistent gap classes reach the owner THROUGH Sam's own report surface.
 * One-shot by design: each lesson is stamped consumed (markConsumed) the run
 * it is surfaced, so a standing lesson never becomes nightly wallpaper.
 * A cross-agent finding carries evidence.mesh_lesson_id, which is also the
 * echo-chamber guard: teachMeshFromSamFindings refuses to re-teach it.
 */
export async function consumeMeshForSam(db, { mesh = DEFAULT_MESH, now = null } = {}) {
  const inbox = await mesh.consumeInbox(db, 'sam', { now })
  const lessons = await mesh.readLessons(db, {
    excludeAuthor: 'sam',
    notConsumedBy: 'sam',
    freshWithinHours: 7 * 24,
    limit: 5,
    now,
  })
  const findings = []
  for (const lesson of lessons) {
    findings.push(makeFinding({
      severity: SEVERITY.INFO,
      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
      title: `Cross-agent lesson from ${lesson.author}: ${lesson.claim}`,
      description: `Shared on the agent mesh (topic: ${lesson.topic}, seen ${lesson.times_seen}×, last ${lesson.updated_at}).`,
      evidence: { mesh_lesson_id: lesson.id, topic: lesson.topic, author: lesson.author, lesson_evidence: lesson.evidence || null },
      recommended_fix: 'Informational: peer telemetry folded into this sweep. Review the evidence if the class persists.',
      confidence: 0.5,
    }))
    await mesh.markConsumed(db, lesson.id, 'sam', { now })
  }
  return { inbox, lessons, findings }
}

/**
 * Run-end teaching: Sam's own crawler_reliability findings (medium+) become
 * lessons on the shared board + a direct message to Amy, so tonight's
 * "web-search backend degraded" is TOMORROW's "don't learn low_results from
 * this outage" instead of a report line the fleet never reads. Bounded to 3
 * per run; the store's (author, topic, claim) dedupe makes repeats a
 * strengthening signal, never spam. Cross-agent findings (evidence.mesh_lesson_id)
 * are never re-taught — heard is not learned-anew.
 */
export async function teachMeshFromSamFindings(db, findings, { mesh = DEFAULT_MESH, now = null } = {}) {
  const teachable = (Array.isArray(findings) ? findings : []).filter((f) => (
    f?.category === SAM_CATEGORIES.CRAWLER_RELIABILITY
    && [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM].includes(f?.severity)
    && !f?.evidence?.mesh_lesson_id
  )).slice(0, 3)
  const taught = []
  for (const f of teachable) {
    const lesson = await mesh.recordLesson(db, {
      author: 'sam',
      topic: 'crawler_reliability',
      claim: f.title,
      evidence: {
        finding_id: f.id || null,
        severity: f.severity,
        category: f.category,
        description: String(f.description || '').slice(0, 300),
      },
      now,
    })
    taught.push({ id: lesson.id, topic: lesson.topic, claim: lesson.claim })
    await mesh.postMessage(db, {
      from: 'sam',
      to: 'amy',
      kind: 'lesson',
      body: f.title,
      data: { lesson_id: lesson.id, severity: f.severity },
      now,
    })
  }
  return taught
}

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
    // When false, suppress the per-run John email (e.g. the light nightly
    // maintenance observe-sweep, so John only gets the real heavy code sweep).
    emailReport = true,
    // Explicit override for the heavy code/function sweep (source-tree walks,
    // ESLint, mission audit). Defaults to gatekeeper-only, but the autonomous
    // autofix scheduler runs repair-safe AND wants the heavy code scan, so it
    // passes includeHeavy:true. null === "use the mode default".
    includeHeavy = null,
    // Free-text instruction the owner attached to this run from the admin UI
    // (see agentControlOrchestrator's per-agent directive channel). Recorded
    // for visibility only — Sam does not infer check scoping from it.
    operatorNote = null,
    // Agent mesh surface (injectable for tests). Best-effort: a mesh failure
    // never fails a Sam run.
    mesh = DEFAULT_MESH,
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
  let adversarialRepairs = null
  let runError = null

  try {
    // ---------- Diagnostics (every mode runs these) -----------------------
    // HEAVY code-quality checks (source-tree walks, ESLint, multi-route HTTP
    // fan-outs) run ONLY in gatekeeper mode (the CI/release sweep). observe /
    // advise — including the autonomous scheduler and the Agent-Control cycle —
    // run the fast operational diagnostics so Sam's preflight can never stall
    // the Robert→Yana→John→Hamilton chain. Explicit checkIds always run as-is.
    const diag = await runDiagnostics({
      db,
      ctx,
      checkIds,
      invokeTool,
      httpProbe,
      includeHeavy: typeof includeHeavy === 'boolean' ? includeHeavy : mode === SAM_MODES.GATEKEEPER,
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
    // "Act, not just report": on the human-AUTHORIZED repair-safe path, when the
    // admin didn't hand-pick fix ids, auto-derive the safe fixes applicable to
    // this run's findings and apply them. This NEVER runs on the scheduler/cron
    // (which is observe — no autonomous code mutation) and applySafeFixes still
    // re-enforces admin + repair-safe + policy gates.
    if (mode === SAM_MODES.REPAIR_SAFE) {
      let effectiveFixIds = Array.isArray(fixIds) ? fixIds : []
      let perFixParams = {}
      if (effectiveFixIds.length === 0 && authorisedByAdmin) {
        const derived = deriveSafeFixesFromFindings(findings)
        effectiveFixIds = derived.fixIds
        perFixParams = derived.perFixParams
      }
      if (effectiveFixIds.length > 0) {
        const fixes = await applySafeFixes({
          fixIds: effectiveFixIds,
          perFixParams,
          // db rides along so DB-level safe fixes (queue.recover-stale-jobs)
          // can act; file-level fixes ignore it.
          context: { authorisedByAdmin, mode, db },
          maxFixes,
        })
        appliedFixes.push(...fixes)
      }

      // OPT-IN new-risk-tier: findings needing a REAL code edit (a "manual"
      // strategy, no deterministic safe fix) get one adversarial author↔verifier
      // repair attempt, landing ONLY a clean-verdict diff through the gated
      // dispatch (PR by default). Gated OFF by default via SAM_ADVERSARIAL_REPAIR
      // so it never fires on the scheduler; additive to applySafeFixes above.
      try {
        adversarialRepairs = await runAdversarialRepairs({
          findings,
          repairPlan,
          runId,
          db,
          maxRounds: 3,
        })
      } catch (advErr) {
        console.warn('[sam] adversarial repair skipped:', advErr?.message || advErr)
      }
    }

    // ---------- Agent mesh: hear, then teach (best-effort) ----------------
    // Consume Sam's inbox + fresh peer lessons (surfaced as INFO findings so
    // they ride the existing report/telemetry surfaces), then teach Sam's own
    // crawler_reliability findings back to the board for Amy's next run.
    let meshSummary = null
    if (db) {
      try {
        const heard = await consumeMeshForSam(db, { mesh })
        findings.push(...heard.findings)
        const taught = await teachMeshFromSamFindings(db, findings, { mesh })
        meshSummary = {
          inbox: heard.inbox.length,
          lessons_heard: heard.lessons.length,
          lessons_taught: taught.length,
          taught,
        }
      } catch (meshErr) {
        console.warn('[sam] agent-mesh exchange skipped:', meshErr?.message || meshErr)
        meshSummary = { error: String(meshErr?.message || meshErr) }
      }
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
      operator_note: operatorNote || null,
      agent_mesh: meshSummary,
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
      adversarial_repairs: adversarialRepairs,
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

      // Owner request: email a per-run report (issues found + corrections made)
      // whenever a sweep surfaces anything. Fires only on findings>0; clean runs
      // send nothing. Best-effort — a mail failure never affects the run result.
      if (emailReport) {
        try {
          out.email_report = await sendSamReportEmail(out)
        } catch (mailErr) {
          console.warn('[sam] report email skipped:', mailErr?.message || mailErr)
        }
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
        qualityLog.error('[sam] failed to persist crash:', persistErr?.message || persistErr)
      }
    }
    const failedOut = {
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
    // A crashed sweep is itself an issue worth surfacing — email it too.
    if (emailReport) {
      try {
        await sendSamReportEmail(failedOut)
      } catch (mailErr) {
        console.warn('[sam] crash report email skipped:', mailErr?.message || mailErr)
      }
    }
    return failedOut
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
  const scheduleAutofix = readEnvBool('SAM_SCHEDULE_AUTOFIX', false)
  const mode = (process.env.SAM_MODE || DEFAULT_MODE).toLowerCase()
  const schedule = process.env.SAM_SCHEDULE || '0 4 * * *'
  const maxFixes = parseMaxFixes()
  const failOnCritical = readEnvBool('SAM_FAIL_ON_CRITICAL', true)
  // SAM_EMAIL_REPORTS defaults ON; only an explicit off-value disables it.
  const emailReports = !/^(0|false|no|off)$/i.test(String(process.env.SAM_EMAIL_REPORTS ?? '').trim())
  const reportEmail = (process.env.SAM_REPORT_EMAIL || process.env.ADMIN_OPS_EMAIL || 'dr.johnwhite@axiombiolabs.org').trim()

  const status = {
    agent: 'Sam',
    purpose: 'production_readiness',
    mode,
    enabled,
    allow_safe_repair: allowSafeRepair,
    run_on_startup: runOnStartup,
    run_on_schedule: runOnSchedule,
    schedule_autofix: scheduleAutofix,
    schedule,
    email_reports: emailReports,
    report_email: reportEmail,
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
