/**
 * samRegistry.js
 *
 * The closed registry of checks Sam can run. Each check is a small object
 * with a stable `id`, a category, a description, and a `run` function.
 *
 * Three check styles are first-class so Sam can compose them without
 * ad-hoc plumbing:
 *
 *   1. tool      — invokes an existing Anya admin tool by name
 *                  (e.g. `admin.code.scan`, `admin.codeGuard.missionVerify`)
 *                  via the in-process tool registry. Most diagnostics live
 *                  here so we never reimplement scanners.
 *
 *   2. http      — issues an internal probe of an HTTP route (e.g. /readyz,
 *                  /api/health/mission). Expressed as a relative path; the
 *                  caller decides how to dispatch (live HTTP in production,
 *                  injected probe in tests).
 *
 *   3. script    — runs an npm script or a node script in the repo root
 *                  via `samSafeFixes.runWhitelistedCommand()`. Used only by
 *                  the gatekeeper / production-gate path. Sam refuses to
 *                  run any command that isn't whitelisted here.
 *
 * The registry also lists the tiny set of DETERMINISTIC safe fixes Sam is
 * permitted to apply in `repair-safe` mode (see `samSafeFixes.js`).
 */

import { SAM_CATEGORIES, SEVERITY } from './samTypes.js'

// ---------------------------------------------------------------------------
// Shape constants
// ---------------------------------------------------------------------------
export const CHECK_KIND = Object.freeze({
  TOOL: 'tool',
  HTTP: 'http',
  SCRIPT: 'script',
  INTERNAL: 'internal',
})

// ---------------------------------------------------------------------------
// Diagnostic checks (read-only — no writes, no scripts)
// ---------------------------------------------------------------------------
//
// Each check that delegates to an Anya tool fails *open* (Sam reports a
// medium finding instead of crashing) when the tool registry hasn't loaded
// yet — that way Sam's status endpoint always responds even if Anya's
// tooling is unavailable.

export const DIAGNOSTIC_CHECKS = Object.freeze([
  {
    id: 'code.scan',
    label: 'Codebase scan (TODOs, debugger, console)',
    category: SAM_CATEGORIES.DEAD_CODE,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.scan',
    parameters: { dryRun: true },
    severityOnFailure: SEVERITY.LOW,
    description: 'Delegates to Anya admin.code.scan to find TODO / debugger / leftover console.* statements without mutating any files.',
  },
  {
    id: 'code.crawl',
    label: 'Codebase pattern crawl',
    category: SAM_CATEGORIES.BROKEN_IMPORTS,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.crawl',
    parameters: { dryRun: true, maxFiles: 200 },
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Delegates to Anya admin.code.crawl to find broken imports, missing handlers, structural drift across the codebase.',
  },
  {
    id: 'code.lint',
    label: 'Code lint snapshot',
    category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.lint',
    parameters: { dryRun: true },
    severityOnFailure: SEVERITY.LOW,
    description: 'Delegates to Anya admin.code.lint to surface ESLint-style issues without applying autofixes.',
  },
  {
    id: 'code.missionAudit',
    label: 'Mission audit (canonical fields, SQL safety, placeholders)',
    category: SAM_CATEGORIES.SQL_SAFETY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.missionAudit',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    description: 'Delegates to runMissionAudit so Sam can see canonical-field violations, unsafe SQL, hardcoded placeholders, etc.',
  },
  {
    id: 'codeGuard.endpointHealth',
    label: 'Endpoint health probe',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.codeGuard.endpointHealth',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    description: 'Delegates to codeGuardService.testEndpoints to probe live API routes and report broken/missing/slow endpoints.',
  },
  {
    id: 'codeGuard.missionVerify',
    label: 'Mission goals verification',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.codeGuard.missionVerify',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    description: 'Delegates to codeGuardService.verifyMissionGoals — the canonical mission-readiness scorecard.',
  },
  {
    id: 'health.check',
    label: 'System health check',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.health.check',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    description: 'Delegates to adminHealthCheck for a system-wide health snapshot.',
  },
  {
    id: 'http.readyz',
    label: 'GET /readyz',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/readyz',
    expectStatus: 200,
    severityOnFailure: SEVERITY.CRITICAL,
    description: 'Liveness/readiness probe — DB ping, schema columns, JWT secret strength, uploads writable.',
  },
  {
    id: 'http.health.mission',
    label: 'GET /api/health/mission',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/health/mission',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Mission-goals health (returns 503 when GrantFlow has slipped; Sam mirrors that into a critical finding).',
  },
  {
    id: 'http.health.imports',
    label: 'GET /api/health/imports',
    category: SAM_CATEGORIES.BROKEN_IMPORTS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/health/imports',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Startup import validation results — fails when production code paths fail to load.',
  },
  {
    id: 'http.version',
    label: 'GET /api/version',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/version',
    expectStatus: 200,
    severityOnFailure: SEVERITY.LOW,
    description: 'Deployment version + commit identifier; helps Sam correlate findings with the running build.',
  },
  // ── Hamilton (Application Autopilot / Funding Completion) checks ────
  // Hamilton is a separate agent from Yana (lead discovery). Sam owns
  // its health gate so the application-completion stack — portal
  // adapters, autopilot engine, blockers store, dual notifications —
  // is exercised on every gatekeeper run.
  {
    id: 'agent.hamilton.health',
    label: 'Hamilton agent health',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-telemetry/hamilton',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms Hamilton telemetry is reachable and the autopilot summary is populated (hamilton_runs, autopilot runs, blockers).',
  },
  {
    id: 'agent.hamilton.routes',
    label: 'Hamilton automation routes',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/tasks',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Probes the canonical Hamilton automation router so renames / mount-point regressions are caught before deploy.',
  },
  {
    id: 'agent.hamilton.portalAutomation',
    label: 'Hamilton portal automation surface',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/portal-policies',
    expectStatus: 200,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Verifies the portal-policy registry endpoint is live so Hamilton can refuse automation on portals where it is not allowed.',
  },
  {
    id: 'agent.hamilton.documents',
    label: 'Hamilton document stack',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.health.check',
    parameters: { area: 'application_documents' },
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Spot-checks document plumbing Hamilton relies on (printable packets, attachments, profile uploads).',
  },
  {
    id: 'agent.hamilton.notifications',
    label: 'Hamilton notifications routing',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/admin/hard-stops',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms the canonical-admin (buckeye7066@gmail.com) hard-stop dashboard is reachable so dual user/admin alerts have a consumer.',
  },
  {
    id: 'agent.hamilton.blockers',
    label: 'Hamilton blocker classifier surface',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/admin/tasks?status=blocked',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Lists currently blocked Hamilton tasks; non-200 means the resolver pipeline is broken or admin guard is misconfigured.',
  },
  {
    id: 'agent.hamilton.security',
    label: 'Hamilton authorization + payment guard',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/payment-authorizations',
    expectStatus: 200,
    severityOnFailure: SEVERITY.CRITICAL,
    description: 'Hamilton must never store raw card data; the authorization endpoint must respond 200 with {ok:true,...} and never echo card numbers.',
  },
  // ── Agent Control Center (admin-only orchestration) checks ─────────
  // Confirms the new Control Center router is mounted, admin-gated, and
  // healthy. Sam is run by the Control Center itself, so this check is
  // technically circular — but it's still useful: every Sam preflight
  // catches a broken router before Robert / Yana / John / Hamilton step
  // start. The non-admin probe also verifies the 403 gate is firing.
  {
    id: 'agent.controlCenter.status',
    label: 'Agent Control Center status route',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-control/status',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms the admin-only Agent Control Center status endpoint is reachable and the canonical-admin gate returns the orchestration snapshot.',
  },
  {
    id: 'agent.controlCenter.lockHygiene',
    label: 'Agent Control Center lock hygiene',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Stale full_cycle locks past their TTL must be auto-released; if they aren\'t, no new run can ever start.',
    async run({ db }) {
      try {
        const row = await db
          ?.prepare(`
            SELECT lock_name, control_run_id, expires_at FROM agent_control_locks
             WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
             LIMIT 1
          `)
          .get()
        if (!row) return { ok: true, summary: 'no expired locks' }
        return {
          ok: false,
          summary: `Expired lock not released: ${row.lock_name} (run ${row.control_run_id})`,
          evidence: row,
        }
      } catch (err) {
        return {
          ok: true,
          summary: `agent_control_locks not present yet (${err?.message || 'unknown'})`,
        }
      }
    },
  },
])

// ---------------------------------------------------------------------------
// Production-gate scripts (only invoked from gatekeeper mode)
// ---------------------------------------------------------------------------
//
// The keys here MUST match an actual npm script name. Sam will skip any
// script that doesn't exist on disk. The whitelist is the single source of
// truth — if it isn't in this list, samSafeFixes.runWhitelistedCommand
// refuses to run it.

export const PRODUCTION_GATE_SCRIPTS = Object.freeze([
  { script: 'scan:secrets',        category: SAM_CATEGORIES.DEPENDENCY_SECURITY,    severityOnFailure: SEVERITY.CRITICAL },
  { script: 'lint:strict',         category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING, severityOnFailure: SEVERITY.HIGH },
  { script: 'typecheck',           category: SAM_CATEGORIES.BUILD_INTEGRITY,        severityOnFailure: SEVERITY.HIGH },
  { script: 'build',               category: SAM_CATEGORIES.BUILD_INTEGRITY,        severityOnFailure: SEVERITY.CRITICAL },
  { script: 'unit',                category: SAM_CATEGORIES.TEST_INTEGRITY,         severityOnFailure: SEVERITY.HIGH },
  { script: 'db:setup',            category: SAM_CATEGORIES.MIGRATION_SAFETY,       severityOnFailure: SEVERITY.HIGH },
  { script: 'crawler:doctor',      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,    severityOnFailure: SEVERITY.HIGH },
  { script: 'crawler:smoke',       category: SAM_CATEGORIES.CRAWLER_RELIABILITY,    severityOnFailure: SEVERITY.MEDIUM },
  { script: 'smoke:apply-engine',  category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY, severityOnFailure: SEVERITY.HIGH },
  { script: 'release:gates',       category: SAM_CATEGORIES.PRODUCTION_CONFIG,      severityOnFailure: SEVERITY.CRITICAL },
  { script: 'test:all',            category: SAM_CATEGORIES.TEST_INTEGRITY,         severityOnFailure: SEVERITY.MEDIUM },
])

// Node scripts Sam may invoke directly (no npm wrapper). The path is
// relative to the repo root and MUST end with .mjs to make tampering
// obvious.
export const PRODUCTION_GATE_NODE_SCRIPTS = Object.freeze([
  {
    label: 'verify-stability',
    file: 'scripts/verify-stability.mjs',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    severityOnFailure: SEVERITY.MEDIUM,
  },
])

// Whitelist used by samSafeFixes.runWhitelistedCommand — the union of npm
// scripts and node scripts Sam is allowed to spawn.
export function buildCommandWhitelist() {
  const npm = PRODUCTION_GATE_SCRIPTS.map((g) => `npm run -s ${g.script}`)
  const node = PRODUCTION_GATE_NODE_SCRIPTS.map((g) => `node ${g.file}`)
  return new Set([...npm, ...node])
}

// ---------------------------------------------------------------------------
// Safe-fix registry (deterministic, low-risk)
// ---------------------------------------------------------------------------
//
// These are the ONLY mutations Sam is willing to apply, and even then only
// in `repair-safe` mode + with explicit admin authorisation. Every entry
// must point to a function in samSafeFixes.js.
//
// The current set is intentionally small. Additions must come with a unit
// test that proves idempotency + rollback.

export const SAFE_FIX_REGISTRY = Object.freeze([
  {
    id: 'docs.regenerate-readiness-log',
    label: 'Regenerate readiness log file',
    risk_level: 'safe',
    description: 'Writes the latest gatekeeper output to docs/_readiness_logs/sam-<timestamp>.log so the run is auditable. Idempotent — never overwrites a previous log.',
  },
  {
    id: 'lint.eslint-fix-file',
    label: 'Run eslint --fix on a single file',
    risk_level: 'safe',
    description: 'Runs eslint with --fix limited to one file when the lint check identified that exact path. Refuses if the file is outside src/ or backend/.',
  },
])

// Quick lookup by id.
export function findSafeFixById(id) {
  return SAFE_FIX_REGISTRY.find((f) => f.id === id) || null
}

// ---------------------------------------------------------------------------
// Default check set used by `observe` / `advise` modes
// ---------------------------------------------------------------------------
export function defaultDiagnosticIds() {
  return DIAGNOSTIC_CHECKS.map((c) => c.id)
}

export function getCheckById(id) {
  return DIAGNOSTIC_CHECKS.find((c) => c.id === id) || null
}
