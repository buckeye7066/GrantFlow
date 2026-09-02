import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  bucketForTaskStatus,
  partitionHamiltonTasks,
} from '../../shared/hamiltonTaskLifecycle.js'
import {
  PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
  parseHamiltonTaskTruthSnapshot,
} from '../../backend/services/hamilton/hamiltonTaskTruthSnapshot.js'

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
const serverSource = fs.readFileSync(
  new URL('../../backend/server.js', import.meta.url),
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
const sqliteMigrationSource = fs.readFileSync(
  new URL('../../backend/db/migrations/1001_live_hamilton_task_truth.mjs', import.meta.url),
  'utf8',
)
const postgresMigrationSource = fs.readFileSync(
  new URL('../../backend/db/postgres/migrations/1001_live_hamilton_task_truth.mjs', import.meta.url),
  'utf8',
)
const strictReconciliationSource = fs.readFileSync(
  new URL('../../backend/services/pipelineStrictReconciliation.js', import.meta.url),
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
  assert.match(policySource, /real:link_reverification_required/)
  assert.match(policySource, /retryable: true/)
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

  assert.match(automationRouteSource, /selectAutoSubmitSources[\s\S]*?const assessment = await assess\(db[\s\S]*?assessment\?\.unavailable[\s\S]*?funding_source_policy_unavailable[\s\S]*?if \(assessment\.ok\) selected\.push/)
  assert.match(orchestratorSource, /childEligibility = await assessHamiltonFundingSource[\s\S]*?if \(!childEligibility\.ok\)[\s\S]*?const child = await ensureApplicationTask/)
  assert.match(orchestratorSource, /childPolicyUnavailable > 0[\s\S]*?status: 'waiting_for_window'/)
  assert.match(policySource, /tasks = await db\.prepare\([\s\S]*?FROM application_tasks/)
})

test('live task-truth migrations cannot advance the ledger after incomplete reconciliation', () => {
  for (const migrationSource of [sqliteMigrationSource, postgresMigrationSource]) {
    assert.match(migrationSource, /await runStrictPipelineReconciliation\(db/)
    assert.doesNotMatch(
      migrationSource,
      /\bcatch\s*\(/,
      'migration 1001 must propagate strict reconciliation failures to its transaction',
    )
  }
})

test('live queue, readiness metric, watch, and triage share current-task truth', () => {
  const endpointSnapshot = automationRouteSource.indexOf('readHamiltonTaskTruthSnapshot(req.db)')
  const endpointPartition = automationRouteSource.indexOf('const currentScoped =', endpointSnapshot)
  assert.ok(endpointSnapshot > 0 && endpointPartition > endpointSnapshot, 'endpoint must verify the cached boot census before labeling operational tasks')
  assert.doesNotMatch(automationRouteSource, /auditUnfinishedHamiltonTasks/)
  assert.match(automationRouteSource, /if \(!taskTruth\.queueReadable\)[\s\S]*?status\(503\)/)
  assert.match(automationRouteSource, /taskBucket: status \? null : 'current'[\s\S]*?limit: null/)
  assert.match(automationRouteSource, /taskBucket: 'finished', limit: 500/)
  assert.match(automationRouteSource, /countApplicationTaskBuckets/)
  assert.match(automationRouteSource, /tasks,[\s\S]*?current,[\s\S]*?history,[\s\S]*?counts,/)
  assert.doesNotMatch(versionRouteSource, /auditUnfinishedHamiltonTasks/)
  assert.match(versionRouteSource, /readHamiltonTaskTruthSnapshot\(db\)/)
  assert.match(versionRouteSource, /PIPELINE_PRECISION_SNAPSHOT_CONTRACT/)
  assert.match(startupSource, /verificationTaskAudit = await auditUnfinishedHamiltonTasks/)
  const cacheInvalidation = startupSource.indexOf("status: 'running'")
  const repairAudit = startupSource.indexOf('const taskRepairAudit = await auditUnfinishedHamiltonTasks')
  assert.ok(cacheInvalidation > 0 && repairAudit > cacheInvalidation, 'old green cache must be invalidated before the boot audit can fail')
  assert.match(startupSource, /persistHamiltonTaskTruthSnapshot\(db, precisionSummary\)/)
  assert.match(startupSource, /if \(pipelinePrecisionRun\) return pipelinePrecisionRun/)
  assert.match(startupSource, /SUBMISSION_UNCERTAIN_TASK_STATUSES/)
  assert.match(startupSource, /NON_CANCELLABLE_TASK_STATUSES/)
  assert.match(strictReconciliationSource, /hasSubmissionUncertainTask[\s\S]*?relabelProtectedHistory/)
  assert.match(strictReconciliationSource, /sourceEvidenceProtected[\s\S]*?removePersistedMatch/)
  assert.match(policySource, /EVIDENCE_PROTECTED_TASK_STATUSES/)
  assert.match(serverSource, /post-link-verification refresh/)
  assert.match(serverSource, /enforcePipelinePrecision\(dbInstance\)/)
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
  assert.equal(legacy.historyTotal, 1)
  const legacyAxios = partitionHamiltonTasks({ data: legacy.current.concat(legacy.history) })
  assert.deepEqual(legacyAxios.current.map((task) => task.id), ['live'])
  assert.deepEqual(legacyAxios.history.map((task) => task.id), ['old'])
  const boundedHistory = partitionHamiltonTasks({
    current: legacy.current,
    history: legacy.history,
    counts: { finished: 501 },
    history_truncated: true,
  })
  assert.equal(boundedHistory.historyTotal, 501)
  assert.equal(boundedHistory.historyTruncated, true)
})

test('cached task truth is green only after a complete zero-deferred read-back', () => {
  const audit = {
    scanned: 2,
    valid: 2,
    invalid: 0,
    deferred: 0,
    protected: 0,
    failed: 0,
    repairFailed: 0,
    truncated: false,
    byGate: {},
    byBucket: {},
  }
  const verified = parseHamiltonTaskTruthSnapshot({
    contract: PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
    timestamp: '2026-09-02T00:00:00.000Z',
    status: 'verified',
    failed: 0,
    deferred: 0,
    truncated: false,
    taskRepairAudit: audit,
    verificationTaskAudit: audit,
  })
  assert.equal(verified.healthy, true)

  assert.equal(parseHamiltonTaskTruthSnapshot({
    ...verified,
    status: 'running',
    taskRepairAudit: audit,
    verificationTaskAudit: audit,
  }).healthy, false)
  assert.equal(parseHamiltonTaskTruthSnapshot({
    contract: PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
    timestamp: '2026-09-02T00:00:00.000Z',
    status: 'verified',
    failed: 0,
    deferred: 1,
    truncated: false,
    taskRepairAudit: { ...audit, deferred: 1 },
    verificationTaskAudit: { ...audit, deferred: 1 },
  }).healthy, false)
  const pending = parseHamiltonTaskTruthSnapshot({
    contract: PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
    timestamp: '2026-09-02T00:00:00.000Z',
    status: 'pending_reverification',
    failed: 0,
    deferred: 1,
    truncated: false,
    taskRepairAudit: { ...audit, deferred: 1 },
    verificationTaskAudit: { ...audit, deferred: 1 },
  })
  assert.equal(pending.healthy, false)
  assert.equal(pending.queueReadable, true, 'reverification debt preserves the read-only task queue')
  assert.equal(parseHamiltonTaskTruthSnapshot({
    timestamp: '2026-09-02T00:00:00.000Z',
    taskRepairAudit: audit,
    verificationTaskAudit: audit,
  }).healthy, false, 'legacy snapshots without an explicit verified status stay red')
})
