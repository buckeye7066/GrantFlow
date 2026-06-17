import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkOnboardingContract,
  findIrrelevantQuestions,
  FINDING_SEVERITY,
} from '../../backend/services/sam/samOnboardingQuestionContract.js'
import { runAudit } from '../../backend/services/sam/samOnboardingConversationAuditor.js'
import {
  summariseFromRows,
  findingsFromTranscriptSummary,
} from '../../backend/services/sam/samOnboardingTranscriptAuditor.js'
import { ANYA_ONBOARDING_QUESTION_TREE } from '../../backend/services/anya/anyaOnboardingQuestionTree.js'
import { ANYA_ONBOARDING_INTAKE_CONTRACT, SUPPORTED_BRANCHES } from '../../backend/services/anya/anyaOnboardingIntakeContract.js'

// ── 1. Canonical tree passes the contract check ─────────────────────────────
test('canonical tree has zero CRITICAL or HIGH findings', () => {
  const result = checkOnboardingContract()
  const blocking = result.findings.filter(
    (f) => f.severity === FINDING_SEVERITY.CRITICAL || f.severity === FINDING_SEVERITY.HIGH,
  )
  assert.deepEqual(
    blocking,
    [],
    `Canonical tree produced blocking findings: ${JSON.stringify(blocking, null, 2)}`,
  )
})

test('coverage report includes every supported branch', () => {
  const result = checkOnboardingContract()
  for (const branch of SUPPORTED_BRANCHES) {
    assert.ok(result.coverage.branches[branch], `coverage missing branch ${branch}`)
    assert.equal(
      result.coverage.branches[branch].required_total,
      result.coverage.branches[branch].required_covered,
      `branch ${branch} has uncovered required fields`,
    )
  }
})

// ── 2. Sam DETECTS missing universal profile_type question ──────────────────
test('detects missing universal profile_type question', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.universal_opening = tree.flow.universal_opening.filter(
    (n) => n.question_id !== 'universal.profile_type',
  )
  const result = checkOnboardingContract({ tree })
  const finding = result.findings.find(
    (f) => f.category === 'missing_universal_question' && f.evidence.intake_field === 'profile_type',
  )
  assert.ok(finding, 'expected missing_universal_question for profile_type')
  assert.equal(finding.severity, 'critical')
})

// ── 3. Sam DETECTS missing location question ────────────────────────────────
test('detects missing location_state universal question', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.universal_opening = tree.flow.universal_opening.filter(
    (n) => n.question_id !== 'universal.location_state',
  )
  const result = checkOnboardingContract({ tree })
  const finding = result.findings.find(
    (f) => f.category === 'missing_universal_question' && f.evidence.intake_field === 'location_state',
  )
  assert.ok(finding, 'expected missing location_state finding')
  assert.equal(finding.severity, 'critical')
})

// ── 4. Sam DETECTS missing universal funding-need question ──────────────────
test('detects missing universal what_they_need (funding need) question', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.universal_opening = tree.flow.universal_opening.filter(
    (n) => n.question_id !== 'universal.what_they_need',
  )
  const result = checkOnboardingContract({ tree })
  assert.ok(
    result.findings.some(
      (f) => f.category === 'missing_universal_question' && f.evidence.intake_field === 'what_they_need',
    ),
  )
})

// ── 5. Sam DETECTS missing branch questions (student) ──────────────────────
test('detects missing student field_of_study question', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.branches.student.required = tree.flow.branches.student.required.filter(
    (n) => n.intake_field !== 'field_of_study',
  )
  const result = checkOnboardingContract({ tree })
  const finding = result.findings.find(
    (f) =>
      f.category === 'missing_branch_question' &&
      f.branch === 'student' &&
      f.evidence.intake_field === 'field_of_study',
  )
  assert.ok(finding, 'expected missing_branch_question for student.field_of_study')
})

// ── 6. Sam DETECTS missing branch questions (church) ────────────────────────
test('detects missing church 501(c)(3) tax_status_known question', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.branches.church.required = tree.flow.branches.church.required.filter(
    (n) => n.intake_field !== 'tax_status_known',
  )
  const result = checkOnboardingContract({ tree })
  assert.ok(
    result.findings.some(
      (f) =>
        f.category === 'missing_branch_question' &&
        f.branch === 'church' &&
        f.evidence.intake_field === 'tax_status_known',
    ),
  )
})

// ── 7. Sam DETECTS missing branch questions (volunteer fire department) ─────
test('detects missing VFD service_area + need_category questions', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.branches.volunteer_fire_department.required = tree.flow.branches.volunteer_fire_department.required.filter(
    (n) => !['service_area', 'vfd_need_category'].includes(n.intake_field),
  )
  const result = checkOnboardingContract({ tree })
  const findings = result.findings.filter(
    (f) => f.category === 'missing_branch_question' && f.branch === 'volunteer_fire_department',
  )
  assert.ok(findings.length >= 2)
})

// ── 8. Sam DETECTS field-mapping gaps ───────────────────────────────────────
test('detects field-mapping gaps when a question writes to no profile fields', () => {
  const fieldMap = [
    {
      question_id: 'church.broken',
      branch: 'church',
      intake_field: 'broken',
      prompt: 'Just an example',
      required: false,
      sensitive: false,
      readiness_category: 'identity',
      maps_to_profile_fields: [],
    },
  ]
  const result = checkOnboardingContract({ fieldMap })
  assert.ok(result.findings.some((f) => f.category === 'field_mapping_gap' && f.question_id === 'church.broken'))
})

// ── 9. Sam DETECTS repeated questions ───────────────────────────────────────
test('detects duplicate intake field within a branch walk', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  // duplicate the first required student question
  const dup = JSON.parse(JSON.stringify(tree.flow.branches.student.required[0]))
  tree.flow.branches.student.required.push(dup)
  const result = checkOnboardingContract({ tree })
  assert.ok(result.findings.some((f) => f.category === 'duplicate_question' && f.branch === 'student'))
})

// ── 10. Sam DETECTS sensitive question without rationale text ───────────────
test('detects sensitive question with no rationale hint in prompt', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  // Strip rationale text from the church.denomination prompt while keeping
  // it flagged sensitive — the auditor must catch this.
  for (const sub of tree.flow.branches.church.required) {
    if (sub.intake_field === 'denomination') {
      sub.sensitive = true
      sub.prompt = 'What is your denomination?'
    }
  }
  const result = checkOnboardingContract({ tree })
  assert.ok(
    result.findings.some(
      (f) => f.category === 'sensitive_no_rationale' && f.question_id === 'church.denomination',
    ),
    'expected sensitive_no_rationale finding',
  )
})

// ── 11. Sam VERIFIES skip / "I don't know" path coverage ────────────────────
test('detects question without skip / i_dont_know path', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  // pick a non-identity question and strip its answer modes
  const studentReq = tree.flow.branches.student.required
  studentReq[0].answer_modes = ['answer']
  const result = checkOnboardingContract({ tree })
  assert.ok(result.findings.some((f) => f.category === 'missing_skip_path'))
})

// ── 12. Sam DETECTS irrelevant questions in a branch ────────────────────────
test('findIrrelevantQuestions catches a question outside the branch contract', () => {
  const tree = JSON.parse(JSON.stringify(ANYA_ONBOARDING_QUESTION_TREE))
  tree.flow.branches.church.recommended.push({
    question_id: 'church.unrelated',
    intake_field: 'made_up_intake_field',
    prompt: 'Random?',
    sensitive: false,
    required: false,
    answer_modes: ['answer', 'skip', 'i_dont_know'],
  })
  const findings = findIrrelevantQuestions({ tree })
  assert.ok(findings.some((f) => f.category === 'irrelevant_question' && f.branch === 'church'))
})

// ── 13. Transcript auditor: privacy — does NOT echo raw answers ─────────────
test('summariseFromRows produces structural counts only, no raw text', () => {
  const rows = [
    {
      session_id: 's1', user_id: 'u1', profile_id: 'p1', branch: 'church',
      event_type: 'onboarding_started', question_id: null, field_key: null,
      status: 'started', confidence: null, created_at: '2026-06-01T00:00:00Z',
    },
    {
      session_id: 's1', user_id: 'u1', profile_id: 'p1', branch: 'church',
      event_type: 'question_asked', question_id: 'universal.profile_type',
      field_key: 'profile_type', status: 'shown', confidence: null,
      created_at: '2026-06-01T00:00:01Z',
    },
    {
      session_id: 's1', user_id: 'u1', profile_id: 'p1', branch: 'church',
      event_type: 'field_extracted', question_id: 'universal.profile_type',
      field_key: 'profile_type', status: 'answered', confidence: 0.95,
      created_at: '2026-06-01T00:00:02Z',
    },
    {
      session_id: 's1', user_id: 'u1', profile_id: 'p1', branch: 'church',
      event_type: 'onboarding_completed', question_id: null, field_key: null,
      status: 'complete', confidence: null, created_at: '2026-06-01T00:00:30Z',
    },
  ]
  const summary = summariseFromRows(rows)
  assert.equal(summary.installed, true)
  assert.equal(summary.sessions.length, 1)
  assert.equal(summary.completion_rate, 1)
  // Crucial privacy check: no raw user text on the session record
  for (const s of summary.sessions) {
    assert.ok(!('details_json' in s))
    assert.ok(!('answer_text' in s))
    assert.ok(!('user_answer' in s))
  }
})

// ── 14. Transcript auditor: low completion produces a finding ───────────────
test('low completion rate produces a HIGH finding', () => {
  const rows = []
  for (let i = 0; i < 10; i++) {
    rows.push({
      session_id: `s${i}`, user_id: `u${i}`, profile_id: null, branch: 'individual',
      event_type: 'onboarding_started', question_id: null, field_key: null,
      status: null, confidence: null, created_at: '2026-06-01T00:00:00Z',
    })
    rows.push({
      session_id: `s${i}`, user_id: `u${i}`, profile_id: null, branch: 'individual',
      event_type: 'question_asked', question_id: 'universal.amount_or_unknown',
      field_key: 'amount_or_unknown', status: 'shown', confidence: null,
      created_at: '2026-06-01T00:00:05Z',
    })
    if (i < 3) {
      rows.push({
        session_id: `s${i}`, user_id: `u${i}`, profile_id: null, branch: 'individual',
        event_type: 'onboarding_completed', question_id: null, field_key: null,
        status: 'complete', confidence: null, created_at: '2026-06-01T00:00:30Z',
      })
    }
  }
  const summary = summariseFromRows(rows)
  assert.ok(summary.completion_rate < 0.5)
  const findings = findingsFromTranscriptSummary(summary)
  assert.ok(findings.some((f) => f.category === 'low_onboarding_completion_rate' && f.severity === 'high'))
})

// ── 15. Orchestrator: runAudit returns a structured payload ─────────────────
test('runAudit (no DB) returns a complete payload with no critical findings on canonical tree', async () => {
  const result = await runAudit(null)
  assert.equal(result.persisted, false)
  assert.ok(result.summary)
  assert.ok(Array.isArray(result.findings))
  assert.ok(Array.isArray(result.recommendations))
  assert.equal(result.summary.flow_version, ANYA_ONBOARDING_QUESTION_TREE.version)
  // Canonical tree should not produce critical findings.
  assert.ok(!result.findings.some((f) => f.severity === 'critical'))
})

test('runAudit reports per-severity finding counts', async () => {
  const result = await runAudit(null)
  assert.ok(result.summary.findings_summary)
  for (const k of ['critical', 'high', 'medium', 'low', 'info', 'total']) {
    assert.ok(typeof result.summary.findings_summary[k] === 'number')
  }
})

// ── 16. Contract is frozen / stable ─────────────────────────────────────────
test('intake contract is frozen and stable', () => {
  assert.ok(Object.isFrozen(ANYA_ONBOARDING_INTAKE_CONTRACT))
  assert.equal(ANYA_ONBOARDING_INTAKE_CONTRACT.version, '1.0.0')
})
