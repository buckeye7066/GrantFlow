/**
 * samRepairPlanner.js
 *
 * Turns diagnostic findings into structured repair plans.
 *
 * The planner does NOT touch any files. It just decides:
 *   - what strategy MIGHT fix this finding
 *   - which files would change
 *   - how risky the fix is
 *   - how to verify it
 *   - how to roll it back
 *   - whether admin approval is required (default: yes for everything)
 *
 * Mission goal 9 (explainable): every plan item links back to a finding by
 * id, so an admin can always answer "why does Sam want to change this
 * file?"
 */

import {
  RISK_LEVEL,
  SAM_CATEGORIES,
  SEVERITY,
  makeRepairPlanItem,
} from './samTypes.js'
import { findSafeFixById } from './samRegistry.js'

// ---------------------------------------------------------------------------
// Strategy table — maps a finding category onto the most-likely strategy
// (and thus risk level). Sam never PROMISES a strategy works — the planner
// just lists the most-likely path. The admin still decides.
// ---------------------------------------------------------------------------

const CATEGORY_STRATEGIES = Object.freeze({
  [SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING]: {
    strategy: 'lint:autofix',
    risk_level: RISK_LEVEL.SAFE,
    safe_fix_id: 'lint.eslint-fix-file',
    verification_commands: ['npm run -s lint:strict'],
  },
  [SAM_CATEGORIES.DEAD_CODE]: {
    strategy: 'remove-unused (manual review required)',
    risk_level: RISK_LEVEL.MODERATE,
    verification_commands: ['npm run -s lint', 'npm run -s unit'],
  },
  [SAM_CATEGORIES.BROKEN_IMPORTS]: {
    strategy: 'fix-import-path',
    risk_level: RISK_LEVEL.MODERATE,
    verification_commands: ['npm run -s typecheck', 'npm run -s build'],
  },
  [SAM_CATEGORIES.BUILD_INTEGRITY]: {
    strategy: 'restore-build (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s build'],
  },
  [SAM_CATEGORIES.TEST_INTEGRITY]: {
    strategy: 'fix-failing-test (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s unit'],
  },
  [SAM_CATEGORIES.ROUTE_INTEGRITY]: {
    strategy: 'investigate-route (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s crawler:doctor', 'curl -s http://localhost:3911/readyz'],
  },
  [SAM_CATEGORIES.SQL_SAFETY]: {
    strategy: 'audit-sql (manual review required)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s unit'],
  },
  [SAM_CATEGORIES.MIGRATION_SAFETY]: {
    strategy: 'investigate-migration (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s db:setup'],
  },
  [SAM_CATEGORIES.AUTH_AND_ADMIN_GUARDS]: {
    strategy: 'add-admin-guard (manual review required)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s unit'],
  },
  [SAM_CATEGORIES.PROFILE_ISOLATION]: {
    strategy: 'profile-scope-audit (manual review required)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s unit'],
  },
  [SAM_CATEGORIES.CRAWLER_RELIABILITY]: {
    strategy: 'crawler-doctor (manual)',
    risk_level: RISK_LEVEL.MODERATE,
    verification_commands: ['npm run -s crawler:doctor'],
  },
  [SAM_CATEGORIES.PRODUCTION_CONFIG]: {
    strategy: 'restore-production-readiness (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['npm run -s release:gates'],
  },
  [SAM_CATEGORIES.UI_ACTION_WIRING]: {
    strategy: 'wire-ui-handler (manual review required)',
    risk_level: RISK_LEVEL.MODERATE,
    verification_commands: ['npm run -s build', 'npm run -s unit'],
  },
  [SAM_CATEGORIES.ENVIRONMENT_READINESS]: {
    strategy: 'set-env-var (manual)',
    risk_level: RISK_LEVEL.RISKY,
    verification_commands: ['curl -s http://localhost:3911/readyz'],
  },
})

const FALLBACK_STRATEGY = Object.freeze({
  strategy: 'manual-investigation-required',
  risk_level: RISK_LEVEL.RISKY,
  verification_commands: ['npm run -s unit'],
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan repairs for a list of findings.
 *
 * @param {SamFinding[]} findings
 * @returns {SamRepairPlanItem[]}
 */
export function planRepairs(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) return []
  return findings.map(planForFinding).filter(Boolean)
}

export function planForFinding(finding) {
  if (!finding || !finding.id) return null
  const profile = CATEGORY_STRATEGIES[finding.category] || FALLBACK_STRATEGY

  // Default risk + strategy from category. If the finding itself flagged
  // safe_auto_fix_available + a known safe fix exists, lower the risk to
  // SAFE. Sam still requires admin approval.
  let risk = profile.risk_level
  let strategy = profile.strategy
  if (finding.safe_auto_fix_available && profile.safe_fix_id && findSafeFixById(profile.safe_fix_id)) {
    risk = RISK_LEVEL.SAFE
    strategy = `safe-fix:${profile.safe_fix_id}`
  }

  // Critical findings outside the safe-fix loop must NEVER be auto-mergeable.
  if (finding.severity === SEVERITY.CRITICAL && risk !== RISK_LEVEL.SAFE) {
    risk = RISK_LEVEL.RISKY
  }

  return makeRepairPlanItem({
    finding_id: finding.id,
    strategy,
    risk_level: risk,
    files_to_change: Array.isArray(finding.affected_files) ? finding.affected_files : [],
    patch_summary: buildPatchSummary(finding, strategy),
    verification_commands: profile.verification_commands || [],
    rollback_plan: buildRollbackPlan(finding),
    requires_admin_approval: true,
  })
}

function buildPatchSummary(finding, strategy) {
  const files = (finding.affected_files || []).slice(0, 3).join(', ') || '(no files identified)'
  const route = (finding.affected_routes || []).slice(0, 3).join(', ')
  const tail = route ? ` · routes: ${route}` : ''
  return `${strategy} · files: ${files}${tail} · finding: ${finding.title}`
}

function buildRollbackPlan(finding) {
  const files = (finding.affected_files || []).filter(Boolean)
  if (files.length === 0) {
    return 'Sam did not alter the working tree. No rollback necessary.'
  }
  return `Revert via git: \`git checkout HEAD -- ${files.slice(0, 5).join(' ')}\``
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------
export const __testing__ = { CATEGORY_STRATEGIES, FALLBACK_STRATEGY }
