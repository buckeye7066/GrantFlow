from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8-sig')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(path, before, after, label):
    text = read(path)
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match in {path}, found {count}')
    write(path, text.replace(before, after, 1))


def replace_between(path, start_marker, end_marker, replacement, label):
    text = read(path)
    start_count = text.count(start_marker)
    if start_count != 1:
        raise RuntimeError(f'{label}: expected one start marker in {path}, found {start_count}')
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    write(path, text[:start] + replacement + text[end + len(end_marker):])


def append_before_last(path, marker, addition, label):
    text = read(path)
    index = text.rfind(marker)
    if index < 0:
        raise RuntimeError(f'{label}: closing marker not found in {path}')
    write(path, text[:index] + addition + text[index:])


policy = 'backend/services/hamilton/hamiltonFundingSourcePolicy.js'
replace_once(
    policy,
    "function unavailablePolicyAssessment(reason = 'canonical_engine_unavailable') {\n  return {\n    ok: false,\n    unavailable: true,\n    gate: 'canonical_accept',",
    "function unavailablePolicyAssessment(reason = 'canonical_engine_unavailable', gate = 'canonical_accept') {\n  return {\n    ok: false,\n    unavailable: true,\n    gate,",
    'parameterize unavailable policy gate',
)
replace_once(
    policy,
    "const POSITIVE_LINK_STATUSES = new Set([",
    "const EVIDENCE_PROTECTED_TASK_STATUSES = new Set([\n  'submitted', 'submit_attempt_started', 'submit_evidence_pending',\n  'submission_verification_required', 'draft_completed', 'completed_draft',\n  'completed', 'complete', 'done', 'archived', 'rejected', 'closed',\n])\nconst POSITIVE_LINK_STATUSES = new Set([",
    'add source-evidence protected statuses',
)
replace_once(
    policy,
    "  if (!POSITIVE_LINK_STATUSES.has(status)) {\n    return {\n      pass: false,\n      reason: `real:link_not_positively_verified:${status || 'missing'}`,",
    "  if (!POSITIVE_LINK_STATUSES.has(status)) {\n    const unavailable = !status\n    return {\n      pass: false,\n      unavailable,\n      retryable: unavailable,\n      reason: `real:link_not_positively_verified:${status || 'missing'}`,",
    'treat missing link status as unavailable evidence',
)
replace_once(
    policy,
    "  if (!Number.isFinite(verifiedAt) || !Number.isFinite(nowMs) || verifiedAt < nowMs - LINK_VERIFICATION_MAX_AGE_MS) {\n    return {\n      pass: false,\n      reason: `real:link_verification_${Number.isFinite(verifiedAt) ? 'stale' : 'missing'}`,",
    "  if (!Number.isFinite(verifiedAt) || !Number.isFinite(nowMs) || verifiedAt < nowMs - LINK_VERIFICATION_MAX_AGE_MS) {\n    return {\n      pass: false,\n      unavailable: true,\n      retryable: true,\n      reason: `real:link_verification_${Number.isFinite(verifiedAt) ? 'stale' : 'missing'}`,",
    'treat stale link verification as unavailable evidence',
)
replace_once(
    policy,
    "  const real = positiveRealityProof(subject, now)\n  if (!real.pass) return { pass: false, gate: 'real', reason: real.reason, evidence: real.evidence }",
    "  const real = positiveRealityProof(subject, now)\n  if (!real.pass) {\n    return {\n      pass: false,\n      unavailable: real.unavailable === true,\n      retryable: real.retryable === true,\n      gate: 'real',\n      reason: real.reason,\n      evidence: real.evidence,\n    }\n  }",
    'propagate reality evidence availability',
)
replace_once(
    policy,
    "  const gates = evaluateHamiltonPositiveGates(subject, facts, { now })\n  if (!gates.pass) {\n    const reason = String(gates.reason || 'not_positively_verified')",
    "  const gates = evaluateHamiltonPositiveGates(subject, facts, { now })\n  if (!gates.pass) {\n    if (gates.unavailable) {\n      return {\n        ...unavailablePolicyAssessment(\n          String(gates.reason || 'real_evidence_unavailable'),\n          gates.gate || 'real',\n        ),\n        retryable: gates.retryable === true,\n        trust,\n        match,\n        stored_match: storedMatch,\n        evidence: gates.evidence ?? null,\n      }\n    }\n    const reason = String(gates.reason || 'not_positively_verified')",
    'return unavailable instead of disallowed for stale evidence',
)
replace_once(
    policy,
    "  const activeTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(asLower(task.status)))\n  // Evidence attached to submitted/finished history must survive cleanup of a\n  // different unfinished task for the same source.",
    "  const protectedEvidenceTask = tasks.find((task) =>\n    EVIDENCE_PROTECTED_TASK_STATUSES.has(asLower(task.status)),\n  )\n  if (protectedEvidenceTask) {\n    return {\n      ...empty,\n      protected_submission_evidence: true,\n      protected_task_id: String(protectedEvidenceTask.id || ''),\n      protected_task_status: asLower(protectedEvidenceTask.status),\n    }\n  }\n\n  const activeTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(asLower(task.status)))\n  // Evidence attached to submitted/finished history must survive cleanup of a\n  // different unfinished task for the same source.",
    'preserve source evidence for submitted and uncertain tasks',
)

reconciliation = 'backend/services/pipelineStrictReconciliation.js'
replace_once(
    reconciliation,
    "      if (assessment.ok) {\n        out.valid += 1\n        classified = true\n        continue\n      }\n\n      out.invalid += 1",
    "      if (assessment.ok) {\n        out.valid += 1\n        classified = true\n        continue\n      }\n\n      const currentTaskStatus = String(task?.status || '').trim().toLowerCase()\n      if (SUBMISSION_UNCERTAIN_TASK_STATUSES.has(currentTaskStatus)) {\n        out.protected += 1\n        classified = true\n        const gate = String(assessment.gate || assessment.code || 'unknown')\n        const reason = String(assessment.reasons?.[0] || assessment.code || 'not_positively_verified')\n        const bucket = bucketForTaskStatus(task?.status)\n        out.byGate[gate] = (out.byGate[gate] || 0) + 1\n        out.byBucket[bucket] = (out.byBucket[bucket] || 0) + 1\n        out.byReason[reason] = (out.byReason[reason] || 0) + 1\n        continue\n      }\n\n      out.invalid += 1",
    'protect submission-uncertain tasks before destructive cleanup',
)
replace_once(
    reconciliation,
    "        out.tasksCancelled += finiteCount(cleanup?.cancelled_tasks)\n        out.matchesRemoved += await removePersistedMatch(db, taskProfileId, opportunityId, { failClosed: true })\n\n        if (grant && !isProtectedHistory(grant)) {",
    "        out.tasksCancelled += finiteCount(cleanup?.cancelled_tasks)\n        const sourceEvidenceProtected = cleanup?.protected_submission_evidence === true\n        if (!sourceEvidenceProtected) {\n          out.matchesRemoved += await removePersistedMatch(db, taskProfileId, opportunityId, { failClosed: true })\n        }\n\n        if (!sourceEvidenceProtected && grant && !isProtectedHistory(grant)) {",
    'guard match and grant cleanup when submission evidence exists',
)
replace_once(
    reconciliation,
    "        } else if (!grant && opportunity) {",
    "        } else if (!sourceEvidenceProtected && !grant && opportunity) {",
    'guard opportunity-only dismissal when submission evidence exists',
)

startup = 'backend/startup/enforceInvariants.js'
replace_once(
    startup,
    "    const grantCols = await listGrantColumns(db)\n    if (!grantCols.has('profile_id') || !grantCols.has('title') || !grantCols.has('status')) {\n      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }\n    }",
    "    const grantCols = await listGrantColumns(db)\n    if (!grantCols.has('profile_id') || !grantCols.has('title') || !grantCols.has('status')) {\n      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }\n    }\n\n    // Invalidate any prior green snapshot before the first potentially failing\n    // precision read or repair. If this boot aborts anywhere below, /api/version\n    // must see an explicit in-progress/unhealthy record rather than yesterday's\n    // successful audit.\n    const precisionAttemptAt = new Date().toISOString()\n    const inProgressTaskAudit = {\n      scanned: 0,\n      valid: 0,\n      invalid: 0,\n      protected: 0,\n      failed: 1,\n      repairFailed: 0,\n      truncated: true,\n      reason: 'startup_pipeline_audit_in_progress',\n    }\n    await db.prepare(\n      'CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)',\n    ).run()\n    await db.prepare(`\n      INSERT INTO system_kv (key, value, updated_at)\n      VALUES (?, ?, ?)\n      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at\n    `).run(\n      'pipeline_precision_last_run',\n      JSON.stringify({\n        timestamp: precisionAttemptAt,\n        status: 'in_progress',\n        healthy: false,\n        failed: 1,\n        truncated: true,\n        reason: 'startup_pipeline_audit_in_progress',\n        taskRepairAudit: inProgressTaskAudit,\n        taskAudit: inProgressTaskAudit,\n        verificationTaskAudit: inProgressTaskAudit,\n      }),\n      precisionAttemptAt,\n    )",
    'invalidate stale healthy startup cache before reconciliation',
)
replace_once(
    startup,
    "    const precisionSummary = {\n      timestamp: precisionTimestamp,",
    "    const precisionSummary = {\n      timestamp: precisionTimestamp,\n      status: 'complete',\n      healthy: true,",
    'mark successful startup precision summary complete',
)

route = 'backend/routes/hamiltonAutomation.js'
replace_once(
    route,
    "import { auditUnfinishedHamiltonTasks } from '../services/pipelineStrictReconciliation.js'\n",
    '',
    'remove destructive reconciliation import from polling route',
)
replace_once(
    route,
    "    let scoped = await listScopedHamiltonTasks({",
    "    const scoped = await listScopedHamiltonTasks({",
    'make read-only task scope immutable',
)
replace_between(
    route,
    "    // The live queue is an acceptance gate, not a stale database dump. Before",
    "    let tasks = scoped.tasks",
    "    // This high-frequency endpoint is deliberately read-only. The exact\n    // funding-source evaluator runs at boot and again after the serialized link\n    // verification/repair cycle; dashboard polling must never delete, cancel, or\n    // reclassify work. The cached readiness endpoint reports an incomplete audit\n    // fail-closed while this route continues to expose the last reconciled queue.\n    let tasks = scoped.tasks",
    'remove destructive full audit from live task polling',
)
replace_once(
    route,
    "/**\n * The set Hamilton's AUTO-SUBMIT (\"all_ready_sources\") expands to.",
    "function readySourcePolicyUnavailable(message, cause = null) {\n  const error = new Error(message)\n  error.code = 'funding_source_policy_unavailable'\n  error.status = 503\n  if (cause) error.cause = cause\n  return error\n}\n\n/**\n * The set Hamilton's AUTO-SUBMIT (\"all_ready_sources\") expands to.",
    'add typed ready-source policy outage',
)
replace_once(
    route,
    "export async function selectAutoSubmitSources(db, profileId, { assess = assessHamiltonFundingSource } = {}) {\n  const ready = await listReadySources(db, profileId)\n  const selected = []",
    "export async function selectAutoSubmitSources(db, profileId, { assess = assessHamiltonFundingSource } = {}) {\n  let ready\n  try {\n    ready = await listReadySources(db, profileId)\n  } catch (err) {\n    throw readySourcePolicyUnavailable(\n      'Hamilton could not load current ready-source evidence.',\n      err,\n    )\n  }\n  const selected = []",
    'fail closed when ready-source rows cannot load',
)
replace_once(
    route,
    "      const assessment = await assess(db, { profileId, opportunity, grant })\n      if (assessment.ok) selected.push(source)\n    } catch (err) {\n      // A ready-source census is a writer precursor. Missing policy evidence\n      // cannot become permission; keep the source visible in Discovery and do\n      // not create Hamilton work for it.\n      log.warn('ready_source_policy_unavailable', {\n        profileId,\n        grantId: source.grant_id,\n        error: err?.message,\n      })\n    }",
    "      const assessment = await assess(db, { profileId, opportunity, grant })\n      if (assessment?.unavailable) {\n        throw readySourcePolicyUnavailable(\n          `Hamilton could not verify current policy for source ${source.grant_id}.`,\n        )\n      }\n      if (assessment.ok) selected.push(source)\n    } catch (err) {\n      // This census is a writer precursor. A mixed result during an evaluator\n      // or database outage would silently turn \"all ready sources\" into an\n      // arbitrary subset, so abort the entire selection and surface 503.\n      log.error('ready_source_policy_unavailable', {\n        profileId,\n        grantId: source.grant_id,\n        error: err?.message,\n      })\n      if (err?.code === 'funding_source_policy_unavailable') throw err\n      throw readySourcePolicyUnavailable(\n        `Hamilton could not verify current policy for source ${source.grant_id}.`,\n        err,\n      )\n    }",
    'propagate policy outages instead of returning a partial source set',
)
replace_once(
    route,
    "  } catch (err) {\n    return res.status(500).json({ error: 'ready_sources_failed', message: err?.message || String(err) })\n  }\n})\n\nrouter.post('/start-autopilot'",
    "  } catch (err) {\n    const unavailable = err?.code === 'funding_source_policy_unavailable' || err?.status === 503\n    return res.status(unavailable ? 503 : 500).json({\n      error: unavailable ? 'funding_source_policy_unavailable' : 'ready_sources_failed',\n      message: err?.message || String(err),\n    })\n  }\n})\n\nrouter.post('/start-autopilot'",
    'surface ready-source evaluator outage as 503',
)
replace_once(
    route,
    "  if (selectedSources.length === 0 && req.body?.all_ready_sources === true) {\n    for (const src of await selectAutoSubmitSources(req.db, profileId)) selectedSources.push(src)\n    // An empty pipeline is a REASON, not a silent no-op that reports queued.",
    "  if (selectedSources.length === 0 && req.body?.all_ready_sources === true) {\n    try {\n      for (const src of await selectAutoSubmitSources(req.db, profileId)) selectedSources.push(src)\n    } catch (err) {\n      log.error('autopilot_ready_source_policy_unavailable', {\n        profileId,\n        error: err?.message,\n      })\n      return res.status(503).json({\n        error: 'funding_source_policy_unavailable',\n        message: 'Hamilton could not verify every ready source, so no partial automation run was started.',\n      })\n    }\n    // An empty pipeline is a REASON, not a silent no-op that reports queued.",
    'block autopilot launch on any ready-source policy outage',
)

server = 'backend/server.js'
replace_once(
    server,
    "          console.log('[link-repair] recurring lifecycle pass:', lifecycle)\n      } catch (err) {",
    "          console.log('[link-repair] recurring lifecycle pass:', lifecycle)\n          // Reconcile Hamilton only after link evidence has been refreshed. This\n          // is a serialized maintenance choke point, unlike the three-second UI\n          // poll route, and it fails visibly if either repair or read-back is\n          // incomplete.\n          const { auditUnfinishedHamiltonTasks } = await import('./services/pipelineStrictReconciliation.js')\n          const taskRepairAudit = await auditUnfinishedHamiltonTasks(dbInstance, {\n            enforce: true,\n            limit: 100000,\n            actor: 'system:recurring-link-verification',\n          })\n          if (taskRepairAudit.failed > 0 || taskRepairAudit.repairFailed > 0 || taskRepairAudit.truncated) {\n            throw new Error(\n              `Hamilton recurring task reconciliation incomplete: failed=${taskRepairAudit.failed}, repair_failed=${taskRepairAudit.repairFailed}, truncated=${taskRepairAudit.truncated}`,\n            )\n          }\n          const taskVerificationAudit = await auditUnfinishedHamiltonTasks(dbInstance, {\n            enforce: false,\n            limit: 100000,\n            actor: 'system:recurring-link-verification-readback',\n          })\n          if (\n            taskVerificationAudit.invalid > 0\n            || taskVerificationAudit.failed > 0\n            || taskVerificationAudit.repairFailed > 0\n            || taskVerificationAudit.truncated\n          ) {\n            throw new Error(\n              `Hamilton recurring task verification incomplete: invalid=${taskVerificationAudit.invalid}, failed=${taskVerificationAudit.failed}, repair_failed=${taskVerificationAudit.repairFailed}, truncated=${taskVerificationAudit.truncated}`,\n            )\n          }\n          console.log('[hamilton-task-truth] recurring reconciliation complete:', {\n            repaired: taskRepairAudit.tasksCancelled,\n            current: taskVerificationAudit.scanned,\n          })\n      } catch (err) {",
    'run Hamilton reconciliation after recurring link verification',
)

source_test = 'tests/unit/hamilton-positive-proof-source.test.mjs'
replace_once(
    source_test,
    "const startupSource = fs.readFileSync(\n  new URL('../../backend/startup/enforceInvariants.js', import.meta.url),\n  'utf8',\n)\nconst watchSource",
    "const startupSource = fs.readFileSync(\n  new URL('../../backend/startup/enforceInvariants.js', import.meta.url),\n  'utf8',\n)\nconst serverSource = fs.readFileSync(\n  new URL('../../backend/server.js', import.meta.url),\n  'utf8',\n)\nconst watchSource",
    'load server source in Hamilton source contract test',
)
replace_once(
    source_test,
    "  const endpointAudit = automationRouteSource.indexOf('auditUnfinishedHamiltonTasks(req.db')\n  const endpointPartition = automationRouteSource.indexOf('const operational =', endpointAudit)\n  assert.ok(endpointAudit > 0 && endpointPartition > endpointAudit, 'endpoint must reconcile before labeling operational tasks')",
    "  assert.doesNotMatch(automationRouteSource, /auditUnfinishedHamiltonTasks/)\n  const endpointPartition = automationRouteSource.indexOf('const operational =')\n  assert.ok(endpointPartition > 0, 'read-only endpoint must partition the reconciled task list')\n  assert.match(serverSource, /actor: 'system:recurring-link-verification'/)",
    'pin read-only live queue and recurring reconciliation ownership',
)
replace_once(
    source_test,
    "  assert.match(startupSource, /'pipeline_precision_last_run'/)",
    "  assert.match(startupSource, /'pipeline_precision_last_run'/)\n  assert.match(startupSource, /startup_pipeline_audit_in_progress/)\n  assert.match(startupSource, /healthy: false/)\n  assert.match(policySource, /unavailable: true,[\\s\\S]{0,80}?retryable: true/)",
    'pin fail-closed cache and stale-evidence availability contract',
)

ready_test = 'backend/tests/readySourcesApplyableStarvation.test.js'
append_before_last(
    ready_test,
    '\n})',
    "\n\n  it('fails the whole selection closed when the policy evaluator is unavailable', async () => {\n    db = await makeDb({ noise: 0, applyableCount: 1 })\n\n    await expect(selectAutoSubmitSources(db, PROFILE, {\n      assess: async () => ({\n        ok: false,\n        unavailable: true,\n        code: 'funding_source_policy_unavailable',\n        reasons: ['canonical_engine_unavailable'],\n      }),\n    })).rejects.toMatchObject({\n      code: 'funding_source_policy_unavailable',\n      status: 503,\n    })\n  })\n\n  it('fails the whole selection closed when one source assessment throws', async () => {\n    db = await makeDb({ noise: 0, applyableCount: 1 })\n\n    await expect(selectAutoSubmitSources(db, PROFILE, {\n      assess: async () => { throw new Error('evaluator offline') },\n    })).rejects.toMatchObject({\n      code: 'funding_source_policy_unavailable',\n      status: 503,\n    })\n  })",
    'add ready-source outage regression tests',
)

pipeline_test = 'backend/tests/pipelineStrictReconciliation.test.js'
append_before_last(
    pipeline_test,
    '\n})',
    "\n\n  it('preserves a submission-uncertain task and its source evidence when policy is hard-invalid', async () => {\n    const { sqlite, db } = await seed()\n    sqlite.prepare(\n      \"UPDATE application_tasks SET status = 'submit_evidence_pending' WHERE grant_id = 'g-good'\",\n    ).run()\n    sqlite.prepare(\n      \"UPDATE funding_opportunities SET link_status = 'dead' WHERE id = 'fo-good'\",\n    ).run()\n\n    const result = await auditUnfinishedHamiltonTasks(db, { enforce: true })\n\n    expect(result.failed).toBe(0)\n    expect(result.repairFailed).toBe(0)\n    expect(result.protected).toBeGreaterThanOrEqual(1)\n    expect(sqlite.prepare(\"SELECT status FROM application_tasks WHERE grant_id = 'g-good'\").get().status)\n      .toBe('submit_evidence_pending')\n    expect(sqlite.prepare(\"SELECT id FROM grants WHERE id = 'g-good'\").get()).toBeTruthy()\n    expect(sqlite.prepare(\"SELECT opportunity_id FROM profile_opportunity_matches WHERE opportunity_id = 'fo-good'\").get())\n      .toBeTruthy()\n  })\n\n  it('cancels new invalid work without deleting source evidence shared with submitted history', async () => {\n    const { sqlite, db } = await seed()\n    sqlite.prepare(`\n      INSERT INTO application_tasks (\n        id, profile_id, opportunity_id, grant_id, status, automation_type\n      ) VALUES ('task-submitted-evidence', ?, 'fo-good', 'g-good', 'submitted', 'portal')\n    `).run(PROFILE_ID)\n    sqlite.prepare(\n      \"UPDATE funding_opportunities SET link_status = 'dead' WHERE id = 'fo-good'\",\n    ).run()\n\n    const result = await auditUnfinishedHamiltonTasks(db, { enforce: true })\n\n    expect(result.failed).toBe(0)\n    expect(result.repairFailed).toBe(0)\n    expect(sqlite.prepare(\"SELECT status FROM application_tasks WHERE grant_id = 'g-good' AND id <> 'task-submitted-evidence'\").get().status)\n      .toBe('cancelled')\n    expect(sqlite.prepare(\"SELECT status FROM application_tasks WHERE id = 'task-submitted-evidence'\").get().status)\n      .toBe('submitted')\n    expect(sqlite.prepare(\"SELECT id FROM grants WHERE id = 'g-good'\").get()).toBeTruthy()\n    expect(sqlite.prepare(\"SELECT opportunity_id FROM profile_opportunity_matches WHERE opportunity_id = 'fo-good'\").get())\n      .toBeTruthy()\n  })",
    'add submission-evidence preservation regression tests',
)

print('Applied Hamilton review fixes with asserted replacements.')
