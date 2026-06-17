import test from 'node:test'
import assert from 'node:assert/strict'

import {
  simulateBranchWalk,
  simulateAllBranches,
  verifyQuickStartContainsAllRequired,
} from '../../backend/services/sam/samOnboardingBranchTests.js'
import { SUPPORTED_BRANCHES } from '../../backend/services/anya/anyaOnboardingIntakeContract.js'

test('simulateBranchWalk yields no errors for canonical tree', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const result = simulateBranchWalk(branch)
    assert.ok(result.nodes.length > 5)
    assert.deepEqual(result.errors, [], `unexpected errors in ${branch}: ${JSON.stringify(result.errors)}`)
  }
})

test('simulateAllBranches summary matches branch count', () => {
  const result = simulateAllBranches()
  assert.equal(result.summary.total_branches, SUPPORTED_BRANCHES.length)
  assert.equal(result.summary.branches_with_errors, 0)
  assert.deepEqual(result.findings, [])
})

test('verifyQuickStartContainsAllRequired passes for canonical tree', () => {
  const findings = verifyQuickStartContainsAllRequired()
  assert.deepEqual(findings, [], 'quick_start lost a required field')
})
