import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  bucketForTaskStatus,
  partitionHamiltonTasks,
} from '../../shared/hamiltonTaskLifecycle.js'

const policySource = fs.readFileSync(
  new URL('../../backend/services/hamilton/hamiltonFundingSourcePolicy.js', import.meta.url),
  'utf8',
)
const orchestratorSource = fs.readFileSync(
  new URL('../../backend/services/hamilton/hamiltonAutomationOrchestrator.js', import.meta.url),
  'utf8',
)
const applicationTasksRouteSource = fs.readFileSync(
  new URL('../../backend/routes/applicationTasks.js', import.meta.url),
  'utf8',
)
const automationRouteSource = fs.readFileSync(
  new URL('../../backend/routes/hamiltonAutomation.js', import.meta.url),
  'utf8',
)
const versionRouteSource = fs.readFileSync(
  new URL('../../backend/routes/version.js', import.meta.url),
  'utf8',
)
const startupSource = fs.readFileSync(
  new URL('../../backend/startup/enforceInvariants.js', import.meta.url),
  'utf8',
)
const watchSource = fs.readFileSync(
  new URL('../../src/pages/HamiltonAutomationWatch.jsx', import.meta.url),
  'utf8',
)
const queueSource = fs.readFileSync(
  new URL('../../src/components/hamilton/HamiltonAutomationQueue.jsx', import.meta.url),
  'utf8',
)
const triageSource = fs.readFileSync(
  new URL('../../src/pages/HamiltonTaskTriage.jsx', import.meta.url),
  'utf8',
)

test('Hamilton policy recomputes ACCEPT and then evaluates every positive gate', () => {
  assert.doesNotMatch(policySource, /ALLOWED_MATCH_DECISIONS/)
  assert.doesNotMatch(policySource, /PROFILE_MATCH_REQUIRED_ORIGINS/)
  assert.doesNotMatch(
    policySource,
    /storedMatch[\s\S]{0,1200}?if \(liveDecision === 'accept'\)[\s\S]{0,200}?ok: true/,
    'stored ACCEPT and live ACCEPT must not skip the positive gates',
  )
  assert.match(policySource, /if \(liveDecision !== 'accept'\)/)
  assert.match(policySource, /evaluateHamiltonPositiveGates\(subject, facts/)
  assert.match(
    policySource,
    /verdict\?\.decision === 'pass'[\s\S]{0,200}?explicit_applicant_types_match/,
  )
  assert.match(policySource, /warnings: \['live_engine_endorsed'\]/)
})

test('every Hamilton funding-policy refusal returns before task creation', () => {
  const refusalIndex = orchestratorSource.indexOf('eligibility?.ok === false')
  const taskCreationIndex = orchestratorSource.indexOf('ensureApplicationTask(db')
  assert.ok(refusalIndex > 0, 'generic eligibility refusal guard must exist')
  assert.ok(taskCreationIndex > refusalIndex, 'policy refusal must run before ensureApplicationTask')
  assert.match(orchestratorSource, /REFUSAL_PROTECTED_TASK_STATUSES/)
  assert.match(orchestratorSource, /status IS NULL OR status NOT IN/)
  assert.doesNotMatch(orchestratorSource, /const SKIP_CLOSEABLE_STATUSES/)

  const rawPolicy = applicationTasksRouteSource.indexOf('const assessment = await assessHamiltonFundingSource')
  const rawRefusal = applicationTasksRouteSource.indexOf('if (!assessment.ok)', rawPolicy)
  const rawCreate = applicationTasksRouteSource.indexOf('ensureApplicationTask(req.db', rawPolicy)
  assert.ok(rawPolicy > 0 && rawRefusal > rawPolicy && rawCreate > rawRefusal, 'raw POST must refuse every failed policy before create')

  assert.match(automationRouteSource, /selectAutoSubmitSources[\s\S]*?const assessment = await assess\(db[\s\S]*?if \(assessment\.ok\) selected\.push/)
  assert.match(orchestratorSource, /childEligibility = await assessHamiltonFundingSource[\s\S]*?if \(!childEligibility\.ok\)[\s\S]*?const child = await ensureApplicationTask/)
  assert.match(orchestratorSource, /childPolicyUnavailable > 0[\s\S]*?status: 'waiting_for_window'/)
  assert.match(policySource, /tasks = await db\.prepare\([\s\S]*?FROM application_tasks/)
})

test('live queue, readiness metric, watch, and triage share current-task truth', () => {
  const endpointAudit = automationRouteSource.indexOf('auditUnfinishedHamiltonTasks(req.db')
  const endpointPartition = automationRouteSource.indexOf('const operational =', endpointAudit)
  assert.ok(endpointAudit > 0 && endpointPartition > endpointAudit, 'endpoint must reconcile before labeling operational tasks')
  assert.match(automationRouteSource, /tasks, current: operational, history, counts/)
  assert.doesNotMatch(versionRouteSource, /auditUnfinishedHamiltonTasks/)
  assert.match(versionRouteSource, /verificationTaskAudit \?\? parsed\.taskAudit/)
  assert.match(versionRouteSource, /evaluator\.invalid === 0/)
  assert.match(versionRouteSource, /numeric_boot_verified_task_truth_v3/)
  assert.match(startupSource, /verificationTaskAudit = await auditUnfinishedHamiltonTasks/)
  assert.match(startupSource, /'pipeline_precision_last_run'/)
  assert.match(watchSource, /partitionHamiltonTasks\(res\)/)
  assert.match(queueSource, /partitionHamiltonTasks\(res\)/)
  assert.match(watchSource, /No unfinished Hamilton work\./)
  assert.match(triageSource, /partitionHamiltonTasks\(res\)/)
  assert.match(triageSource, /bucketForTaskStatus\(t\?\.status\) === 'finished'/)

  for (const status of ['complete', 'done', 'canceled', 'archived', 'rejected', 'closed']) {
    assert.equal(bucketForTaskStatus(status), 'finished', `${status} must remain terminal during rollout`)
  }
  const legacy = partitionHamiltonTasks({
    tasks: [{ id: 'live', status: 'queued' }, { id: 'old', status: 'complete' }],
  })
  assert.deepEqual(legacy.current.map((task) => task.id), ['live'])
  assert.deepEqual(legacy.history.map((task) => task.id), ['old'])
})
