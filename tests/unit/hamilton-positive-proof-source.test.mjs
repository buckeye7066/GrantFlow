import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const policySource = fs.readFileSync(
  new URL('../../backend/services/hamilton/hamiltonFundingSourcePolicy.js', import.meta.url),
  'utf8',
)
const orchestratorSource = fs.readFileSync(
  new URL('../../backend/services/hamilton/hamiltonAutomationOrchestrator.js', import.meta.url),
  'utf8',
)

test('Hamilton policy requires ACCEPT and still evaluates applicant proof after live ACCEPT', () => {
  assert.match(policySource, /const ALLOWED_MATCH_DECISIONS = new Set\(\['accept'\]\)/)
  assert.doesNotMatch(policySource, /PROFILE_MATCH_REQUIRED_ORIGINS/)
  assert.doesNotMatch(
    policySource,
    /if \(liveDecision === 'accept'\) \{[\s\S]{0,900}?return \{[\s\S]{0,200}?ok: true/,
    'live ACCEPT must become evidence and fall through to applicant-type proof, not return success',
  )
  assert.match(policySource, /if \(liveDecision === 'accept'\) \{\s*match = \{/)
  assert.match(
    policySource,
    /applicantVerdict\?\.decision === 'pass'[\s\S]{0,200}?explicit_applicant_types_match/,
  )
  assert.match(policySource, /warnings: match\?\.live \? \['live_engine_endorsed'\] : \[\]/)
})

test('every Hamilton funding-policy refusal returns before task creation', () => {
  const refusalIndex = orchestratorSource.indexOf('eligibility?.ok === false')
  const taskCreationIndex = orchestratorSource.indexOf('ensureApplicationTask(db')
  assert.ok(refusalIndex > 0, 'generic eligibility refusal guard must exist')
  assert.ok(taskCreationIndex > refusalIndex, 'policy refusal must run before ensureApplicationTask')
  assert.match(orchestratorSource, /REFUSAL_PROTECTED_TASK_STATUSES/)
  assert.match(orchestratorSource, /status IS NULL OR status NOT IN/)
  assert.doesNotMatch(orchestratorSource, /const SKIP_CLOSEABLE_STATUSES/)
})
