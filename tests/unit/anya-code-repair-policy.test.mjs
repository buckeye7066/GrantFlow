import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANYA_CODE_REPAIR_POLICY,
  ANYA_GOALS,
  ANYA_GOALS_TEXT,
} from '../../backend/config/missionGoals.js'

test('Anya code-error repair is a canonical mission rule', () => {
  assert.equal(ANYA_CODE_REPAIR_POLICY.scope, 'code_error_repair')
  assert.equal(ANYA_CODE_REPAIR_POLICY.full_repository_write_access, true)
  assert.equal(ANYA_CODE_REPAIR_POLICY.permission_required, false)
  assert.equal(ANYA_CODE_REPAIR_POLICY.audit_required, true)

  const repairGoal = ANYA_GOALS.find((goal) => goal.short === 'Autonomous code repair')
  assert.ok(repairGoal)
  assert.match(repairGoal.rule, /full repository write access/)
  assert.match(repairGoal.rule, /without asking for additional permission/)
  assert.match(ANYA_GOALS_TEXT, /AUTONOMOUS CODE REPAIR/)
})
