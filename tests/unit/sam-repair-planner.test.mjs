/**
 * Unit tests for samRepairPlanner.js.
 *
 * Plans must:
 *   - link back to the finding by id
 *   - never auto-mark themselves as not requiring admin approval
 *   - escalate to RISKY for critical findings unless the safe-fix path is wired up
 *   - generate a sensible patch summary + rollback plan
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RISK_LEVEL,
  SAM_CATEGORIES,
  SEVERITY,
  makeFinding,
} from '../../backend/services/sam/samTypes.js'
import {
  planForFinding,
  planRepairs,
} from '../../backend/services/sam/samRepairPlanner.js'

test('planForFinding returns null for invalid finding', () => {
  assert.equal(planForFinding(null), null)
  assert.equal(planForFinding({}), null)
})

test('every plan item links to its finding by id and requires admin approval', () => {
  const findings = [
    makeFinding({ severity: SEVERITY.HIGH, category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING, title: 'console.log left in prod', affected_files: ['backend/services/foo.js'] }),
    makeFinding({ severity: SEVERITY.CRITICAL, category: SAM_CATEGORIES.SQL_SAFETY, title: 'unsafe sql concat', affected_files: ['backend/services/q.js'] }),
    makeFinding({ severity: SEVERITY.MEDIUM, category: SAM_CATEGORIES.BROKEN_IMPORTS, title: 'bad import path', affected_files: ['src/x.jsx'] }),
  ]
  const plans = planRepairs(findings)
  assert.equal(plans.length, findings.length)
  for (let i = 0; i < plans.length; i += 1) {
    assert.equal(plans[i].finding_id, findings[i].id)
    assert.equal(plans[i].requires_admin_approval, true)
    assert.ok(plans[i].patch_summary.length > 0)
    assert.ok(plans[i].rollback_plan.length > 0)
  }
})

test('logging/error category with safe_auto_fix_available downgrades risk to SAFE', () => {
  const f = makeFinding({
    severity: SEVERITY.HIGH,
    category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING,
    title: 'lint issue',
    affected_files: ['src/components/Foo.jsx'],
    safe_auto_fix_available: true,
  })
  const plan = planForFinding(f)
  assert.equal(plan.risk_level, RISK_LEVEL.SAFE)
  assert.match(plan.strategy, /safe-fix:lint\.eslint-fix-file/)
})

test('critical findings outside safe-fix path stay RISKY', () => {
  const f = makeFinding({
    severity: SEVERITY.CRITICAL,
    category: SAM_CATEGORIES.SQL_SAFETY,
    title: 'unsafe sql',
    affected_files: ['backend/services/x.js'],
    safe_auto_fix_available: true,                  // even with this hint
  })
  const plan = planForFinding(f)
  assert.equal(plan.risk_level, RISK_LEVEL.RISKY)
})

test('plan rollback plan references the affected files', () => {
  const f = makeFinding({
    severity: SEVERITY.MEDIUM,
    category: SAM_CATEGORIES.BROKEN_IMPORTS,
    title: 'bad import',
    affected_files: ['src/components/Foo.jsx', 'src/api/foo.js'],
  })
  const plan = planForFinding(f)
  assert.match(plan.rollback_plan, /git checkout HEAD/)
  assert.match(plan.rollback_plan, /Foo\.jsx/)
})

test('plan with no affected files reports no rollback needed', () => {
  const f = makeFinding({ severity: SEVERITY.LOW, category: SAM_CATEGORIES.PRODUCTION_CONFIG, title: 'config note' })
  const plan = planForFinding(f)
  assert.match(plan.rollback_plan, /did not alter the working tree/i)
})
