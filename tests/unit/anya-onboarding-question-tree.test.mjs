import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ANYA_ONBOARDING_QUESTION_TREE,
  walkOnboarding,
  intakeFieldsAskedForBranch,
  sensitiveQuestionsForBranch,
  fingerprintTree,
} from '../../backend/services/anya/anyaOnboardingQuestionTree.js'
import {
  SUPPORTED_BRANCHES,
  UNIVERSAL_REQUIRED_FIELDS,
} from '../../backend/services/anya/anyaOnboardingIntakeContract.js'

test('tree exposes universal_opening + branches + universal_keep_asking', () => {
  assert.ok(Array.isArray(ANYA_ONBOARDING_QUESTION_TREE.flow.universal_opening))
  assert.ok(typeof ANYA_ONBOARDING_QUESTION_TREE.flow.branches === 'object')
  assert.ok(Array.isArray(ANYA_ONBOARDING_QUESTION_TREE.flow.universal_keep_asking))
})

test('walkOnboarding starts with profile_type for every branch', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const nodes = walkOnboarding({ branch })
    assert.equal(nodes[0].question_id, 'universal.profile_type', `branch ${branch} did not start with profile_type`)
  }
})

test('walkOnboarding asks every universal required field for every branch', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const asked = new Set(walkOnboarding({ branch }).map((n) => n.intake_field))
    for (const f of UNIVERSAL_REQUIRED_FIELDS) {
      assert.ok(asked.has(f), `branch ${branch} skipped universal field ${f}`)
    }
  }
})

test('intakeFieldsAskedForBranch contains every required intake field', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const asked = intakeFieldsAskedForBranch(branch)
    for (const f of UNIVERSAL_REQUIRED_FIELDS) {
      assert.ok(asked.has(f), `${branch} did not ask universal ${f}`)
    }
  }
})

test('quick_start drops recommended-only universal questions', () => {
  const fullKa = walkOnboarding({ branch: 'individual', pace: 'keep_asking' }).length
  const quick = walkOnboarding({ branch: 'individual', pace: 'quick_start' }).length
  assert.ok(quick < fullKa, 'quick_start should be shorter')
})

test('quick_start STILL covers universal required fields', () => {
  const quick = walkOnboarding({ branch: 'family', pace: 'quick_start' })
  const asked = new Set(quick.map((n) => n.intake_field))
  for (const f of UNIVERSAL_REQUIRED_FIELDS) {
    assert.ok(asked.has(f), `quick_start dropped universal required ${f}`)
  }
})

test('non-identity questions all have skip + i_dont_know modes', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    for (const node of walkOnboarding({ branch })) {
      if (node.question_id === 'universal.profile_type' || node.question_id === 'universal.profile_name') continue
      assert.ok(node.answer_modes.includes('skip'), `${node.question_id} missing skip mode`)
      assert.ok(node.answer_modes.includes('i_dont_know'), `${node.question_id} missing i_dont_know mode`)
    }
  }
})

test('identity questions are NOT skippable', () => {
  const tree = ANYA_ONBOARDING_QUESTION_TREE
  const profileType = tree.flow.universal_opening.find((n) => n.question_id === 'universal.profile_type')
  const profileName = tree.flow.universal_opening.find((n) => n.question_id === 'universal.profile_name')
  assert.deepEqual(profileType.answer_modes, ['answer'])
  assert.deepEqual(profileName.answer_modes, ['answer'])
})

test('sensitiveQuestionsForBranch returns expected sets', () => {
  const indiv = sensitiveQuestionsForBranch('individual').map((n) => n.intake_field)
  assert.ok(indiv.includes('household_income_range'))
  assert.ok(indiv.includes('disability_or_health_need'))

  const sb = sensitiveQuestionsForBranch('small_business').map((n) => n.intake_field)
  assert.ok(sb.includes('annual_revenue_range'))
  assert.ok(sb.includes('minority_woman_veteran_ownership'))

  // Church denomination is sensitive in the contract; verify the tree
  // surfaces it as such.
  const ch = sensitiveQuestionsForBranch('church').map((n) => n.intake_field)
  assert.ok(ch.includes('denomination'))
})

test('fingerprintTree is stable and changes if a node moves', () => {
  const fp1 = fingerprintTree()
  const fp2 = fingerprintTree()
  assert.equal(fp1, fp2)

  // mutate a copy and verify fingerprint differs
  const mutated = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  mutated.flow.universal_opening.reverse()
  const fp3 = fingerprintTree(mutated)
  assert.notEqual(fp1, fp3)
})
