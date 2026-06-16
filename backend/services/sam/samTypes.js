/**
 * samTypes.js
 *
 * Shared constants + shape helpers for Sam, GrantFlow's production-readiness
 * agent. No runtime dependencies — everything here is pure data + small
 * factory functions so unit tests can use these constants directly.
 *
 * These are JS objects (not TypeScript) because the rest of the backend is
 * JS, but each shape is documented as a JSDoc typedef so editors give the
 * same hints as a `.d.ts`.
 */

// ---------------------------------------------------------------------------
// Modes — what Sam is allowed to do during a run.
// ---------------------------------------------------------------------------
export const SAM_MODES = Object.freeze({
  OBSERVE: 'observe',         // read-only diagnostics; no plans, no writes
  ADVISE: 'advise',           // read-only diagnostics + repair plan; no writes
  REPAIR_SAFE: 'repair-safe', // may apply DETERMINISTIC safe fixes when authorised
  GATEKEEPER: 'gatekeeper',   // runs production gates; pass/fail; no writes
})

export const SAM_MODE_LIST = Object.freeze(Object.values(SAM_MODES))

export function isValidMode(value) {
  return SAM_MODE_LIST.includes(String(value || '').toLowerCase())
}

export const DEFAULT_MODE = SAM_MODES.OBSERVE

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
export const SAM_TRIGGERS = Object.freeze({
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  STARTUP: 'startup',
  ADMIN_UI: 'admin-ui',
  API: 'api',
})

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------
export const SAM_RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

// ---------------------------------------------------------------------------
// Severity ladder
// ---------------------------------------------------------------------------
export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
})

export const SEVERITY_ORDER = Object.freeze([
  SEVERITY.CRITICAL,
  SEVERITY.HIGH,
  SEVERITY.MEDIUM,
  SEVERITY.LOW,
  SEVERITY.INFO,
])

// Higher = worse; matters for sort + health score.
export const SEVERITY_WEIGHT = Object.freeze({
  [SEVERITY.CRITICAL]: 25,
  [SEVERITY.HIGH]: 10,
  [SEVERITY.MEDIUM]: 4,
  [SEVERITY.LOW]: 1,
  [SEVERITY.INFO]: 0,
})

// ---------------------------------------------------------------------------
// Diagnostic categories (closed list — extend deliberately)
// ---------------------------------------------------------------------------
export const SAM_CATEGORIES = Object.freeze({
  BUILD_INTEGRITY: 'build_integrity',
  TEST_INTEGRITY: 'test_integrity',
  ROUTE_INTEGRITY: 'route_integrity',
  FRONTEND_BACKEND_WIRING: 'frontend_backend_wiring',
  ADMIN_TOOL_INTEGRITY: 'admin_tool_integrity',
  PROFILE_ISOLATION: 'profile_isolation',
  SQL_SAFETY: 'sql_safety',
  AUTH_AND_ADMIN_GUARDS: 'auth_and_admin_guards',
  MIGRATION_SAFETY: 'migration_safety',
  CRAWLER_RELIABILITY: 'crawler_reliability',
  OPPORTUNITY_INTEGRITY: 'opportunity_integrity',
  APPLICATION_WORKFLOW_INTEGRITY: 'application_workflow_integrity',
  DEPENDENCY_SECURITY: 'dependency_security',
  LOGGING_AND_ERROR_HANDLING: 'logging_and_error_handling',
  PRODUCTION_CONFIG: 'production_config',
  DEAD_CODE: 'dead_code',
  BROKEN_IMPORTS: 'broken_imports',
  UI_ACTION_WIRING: 'ui_action_wiring',
  ENVIRONMENT_READINESS: 'environment_readiness',
})

export const SAM_CATEGORY_LIST = Object.freeze(Object.values(SAM_CATEGORIES))

// ---------------------------------------------------------------------------
// Risk levels for repair plans
// ---------------------------------------------------------------------------
export const RISK_LEVEL = Object.freeze({
  SAFE: 'safe',
  MODERATE: 'moderate',
  RISKY: 'risky',
})

// ---------------------------------------------------------------------------
// Shape factories — these are the canonical shapes Sam produces. Use them
// instead of constructing the objects ad-hoc so the contract stays stable.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SamFinding
 * @property {string} id
 * @property {'critical'|'high'|'medium'|'low'|'info'} severity
 * @property {string} category
 * @property {string} title
 * @property {string} description
 * @property {object} evidence
 * @property {string[]} affected_files
 * @property {string[]} affected_routes
 * @property {string} recommended_fix
 * @property {boolean} safe_auto_fix_available
 * @property {number} confidence
 * @property {string} created_at
 */
export function makeFinding({
  id,
  severity = SEVERITY.MEDIUM,
  category = SAM_CATEGORIES.BUILD_INTEGRITY,
  title,
  description = '',
  evidence = {},
  affected_files = [],
  affected_routes = [],
  recommended_fix = '',
  safe_auto_fix_available = false,
  confidence = 0.7,
} = {}) {
  if (!title) throw new Error('makeFinding: title is required')
  if (!Object.values(SEVERITY).includes(severity)) {
    throw new Error(`makeFinding: invalid severity ${severity}`)
  }
  if (!SAM_CATEGORY_LIST.includes(category)) {
    throw new Error(`makeFinding: invalid category ${category}`)
  }
  return {
    id: id ?? `sam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    severity,
    category,
    title,
    description,
    evidence,
    affected_files: Array.isArray(affected_files) ? affected_files : [],
    affected_routes: Array.isArray(affected_routes) ? affected_routes : [],
    recommended_fix,
    safe_auto_fix_available: Boolean(safe_auto_fix_available),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
    created_at: new Date().toISOString(),
  }
}

/**
 * @typedef {object} SamRepairPlanItem
 * @property {string} finding_id
 * @property {string} strategy
 * @property {'safe'|'moderate'|'risky'} risk_level
 * @property {string[]} files_to_change
 * @property {string} patch_summary
 * @property {string[]} verification_commands
 * @property {string} rollback_plan
 * @property {boolean} requires_admin_approval
 */
export function makeRepairPlanItem({
  finding_id,
  strategy,
  risk_level = RISK_LEVEL.RISKY,
  files_to_change = [],
  patch_summary = '',
  verification_commands = [],
  rollback_plan = 'Revert via git: `git checkout HEAD -- <file>`',
  requires_admin_approval = true,
} = {}) {
  if (!finding_id) throw new Error('makeRepairPlanItem: finding_id is required')
  if (!strategy) throw new Error('makeRepairPlanItem: strategy is required')
  if (!Object.values(RISK_LEVEL).includes(risk_level)) {
    throw new Error(`makeRepairPlanItem: invalid risk_level ${risk_level}`)
  }
  return {
    finding_id,
    strategy,
    risk_level,
    files_to_change: Array.isArray(files_to_change) ? files_to_change : [],
    patch_summary,
    verification_commands: Array.isArray(verification_commands) ? verification_commands : [],
    rollback_plan,
    // SAFE-risk plans STILL require admin approval to APPLY — Sam never
    // mutates code without an authorised admin call.
    requires_admin_approval: requires_admin_approval !== false,
  }
}

// ---------------------------------------------------------------------------
// Health score — 0..100, computed from severity-weighted finding counts.
// Sam reports `production_ready: true` only if zero critical findings and a
// score >= 80. Callers can override via env (SAM_FAIL_ON_CRITICAL) but the
// default is strict.
// ---------------------------------------------------------------------------
export function computeHealthScore(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) return 100
  let penalty = 0
  for (const f of findings) {
    penalty += SEVERITY_WEIGHT[f?.severity] ?? 0
  }
  return Math.max(0, Math.min(100, 100 - penalty))
}

export function summariseFindings(findings = []) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) {
    if (counts[f?.severity] !== undefined) counts[f.severity] += 1
  }
  return {
    total: findings.length,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    info: counts.info,
  }
}

export function determineProductionReady(findings = [], { failOnCritical = true } = {}) {
  const summary = summariseFindings(findings)
  if (failOnCritical && summary.critical > 0) return false
  if (summary.high > 5) return false
  return computeHealthScore(findings) >= 80
}
