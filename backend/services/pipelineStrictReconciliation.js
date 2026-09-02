import { createLogger } from '../utils/logger.js'
import { cleanExtractedText } from '../utils/htmlTextHygiene.js'
import {
  buildPipelineRowSql,
  loadProfileFacts,
  PROTECTED_GRANT_STATUSES,
} from './robert/robertPipelineAudit.js'
import { recordDismissal } from './pipelineDismissals.js'
import { cancelApplicationTask } from './hamilton/applicationTaskStore.js'
import {
  assessHamiltonFundingSource,
  cleanupDisallowedHamiltonTraces,
} from './hamilton/hamiltonFundingSourcePolicy.js'
import { bucketForTaskStatus } from '../../shared/hamiltonTaskLifecycle.js'
import {
  persistHamiltonTaskTruthSnapshot,
  readHamiltonTaskTruthSnapshot,
} from './hamilton/hamiltonTaskTruthSnapshot.js'

const log = createLogger('pipeline-strict-reconciliation')

const TASK_HISTORY_STATUSES = Object.freeze([
  'submitted', 'draft_completed', 'completed_draft', 'completed', 'complete', 'done', 'failed', 'cancelled', 'canceled',
  'archived', 'rejected', 'closed',
])
const SUBMISSION_UNCERTAIN_TASK_STATUSES = new Set([
  'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required',
])
const NON_CANCELLABLE_TASK_STATUSES = Object.freeze([
  ...TASK_HISTORY_STATUSES,
  ...SUBMISSION_UNCERTAIN_TASK_STATUSES,
])

function changesOf(result) {
  const n = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(n) ? n : 0
}

function normalizePipelineRow(row) {
  const title = cleanExtractedText(row?.opp_title || row?.grant_title || '') || ''
  const sponsor = cleanExtractedText(row?.sponsor || row?.funder || '') || null
  return {
    ...row,
    id: row?.funding_opportunity_id || row?.grant_id || null,
    title,
    sponsor,
    funder: sponsor,
    deadline: row?.opp_deadline || row?.grant_deadline || null,
    application_url:
      row?.opp_application_url || row?.apply_url || row?.grant_application_url || null,
    source_url:
      row?.source_url || row?.final_url || row?.evidence_url || row?.grant_url || null,
  }
}

async function activeProfileIds(db) {
  try {
    const rows = await db.prepare(`
      SELECT id
        FROM profiles
       WHERE (deleted_at IS NULL)
         AND (status IS NULL OR LOWER(status) <> 'deleted')
         AND LOWER(COALESCE(display_name, '')) NOT LIKE '%sasquatch%'
       ORDER BY id
    `).all()
    return (rows || []).map((row) => String(row.id)).filter(Boolean)
  } catch {
    const rows = await db.prepare('SELECT id FROM profiles ORDER BY id').all()
    return (rows || []).map((row) => String(row.id)).filter(Boolean)
  }
}

async function pipelineRowsIncludingLegacyLeads(db, profileId) {
  const canonicalSql = await buildPipelineRowSql(db)
  const allRowsSql = canonicalSql.replace(
    "\n    AND (g.pipeline_category IS NULL OR LOWER(g.pipeline_category) <> 'funder_lead')",
    '',
  )
  const rows = await db.prepare(allRowsSql).all(String(profileId))
  return (rows || []).map(normalizePipelineRow)
}

function isProtectedHistory(row) {
  const status = String(row?.grant_status || row?.status || '').trim().toLowerCase()
  if (status && PROTECTED_GRANT_STATUSES.has(status)) return true
  const awarded = Number(row?.amount_awarded)
  return Number.isFinite(awarded) && awarded > 0
}

async function cancelActiveTasks(db, profileId, row, reason) {
  const pairParams = [
    String(profileId),
    row?.grant_id ? String(row.grant_id) : null,
    row?.funding_opportunity_id ? String(row.funding_opportunity_id) : null,
  ]

  try {
    await db.prepare(`
      UPDATE application_tasks
         SET allow_auto_submit = FALSE,
             auto_submit_enabled = FALSE
       WHERE profile_id = ?
         AND ((grant_id IS NOT NULL AND grant_id = ?)
           OR (opportunity_id IS NOT NULL AND opportunity_id = ?))
    `).run(...pairParams)
  } catch {
    // Older task schemas may not carry both intent columns. Cancellation below
    // remains the authority and still fails closed for active work.
  }

  let rows = []
  try {
    const placeholders = NON_CANCELLABLE_TASK_STATUSES.map(() => '?').join(', ')
    rows = await db.prepare(`
      SELECT id
        FROM application_tasks
       WHERE profile_id = ?
         AND ((grant_id IS NOT NULL AND grant_id = ?)
           OR (opportunity_id IS NOT NULL AND opportunity_id = ?))
         AND LOWER(COALESCE(status, '')) NOT IN (${placeholders})
    `).all(...pairParams, ...NON_CANCELLABLE_TASK_STATUSES)
  } catch {
    return 0
  }

  let cancelled = 0
  for (const task of rows || []) {
    cancelled += await cancelTaskFailClosed(db, task.id, reason)
  }
  return cancelled
}

async function cancelTaskFailClosed(db, taskId, reason) {
  try {
    await cancelApplicationTask(db, taskId, {
      actorRole: 'system',
      reason,
    })
    return 1
  } catch (transitionError) {
    // A stale/legacy status must not keep unsafe Hamilton work active. Preserve
    // the task as cancelled history even when the normal transition service
    // cannot interpret its old state.
    let updated
    try {
      updated = await db.prepare(`
        UPDATE application_tasks
           SET status = 'cancelled',
               allow_auto_submit = FALSE,
               auto_submit_enabled = FALSE,
               last_agent_message = ?
         WHERE id = ?
      `).run(reason, taskId)
    } catch {
      updated = await db.prepare(
        "UPDATE application_tasks SET status = 'cancelled', last_agent_message = ? WHERE id = ?",
      ).run(reason, taskId)
    }
    if (changesOf(updated) !== 1) throw transitionError
    return 1
  }
}

export async function cancelInvalidActiveHamiltonTasks(db, {
  reason = 'Hamilton task cancelled because its funding source is missing or rejected.',
} = {}) {
  const placeholders = NON_CANCELLABLE_TASK_STATUSES.map(() => '?').join(', ')
  let rows
  try {
    rows = await db.prepare(`
      SELECT t.id
        FROM application_tasks t
       WHERE LOWER(COALESCE(t.status, '')) NOT IN (${placeholders})
         AND (
           (t.grant_id IS NULL AND t.opportunity_id IS NULL)
           OR (
             t.grant_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = t.grant_id)
           )
           OR (
             t.opportunity_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM funding_opportunities fo WHERE fo.id = t.opportunity_id)
           )
           OR EXISTS (
             SELECT 1 FROM grants rejected
              WHERE rejected.id = t.grant_id
                AND (
                  LOWER(COALESCE(rejected.eligibility_status, '')) = 'ineligible'
                  OR LOWER(COALESCE(rejected.match_decision, '')) = 'reject'
                )
           )
           OR EXISTS (
             SELECT 1 FROM grants rejected_pair
              WHERE rejected_pair.profile_id = t.profile_id
                AND rejected_pair.funding_opportunity_id = t.opportunity_id
                AND (
                  LOWER(COALESCE(rejected_pair.eligibility_status, '')) = 'ineligible'
                  OR LOWER(COALESCE(rejected_pair.match_decision, '')) = 'reject'
                )
           )
         )
    `).all(...NON_CANCELLABLE_TASK_STATUSES)
  } catch (error) {
    log.warn('invalid Hamilton task sweep could not load candidates', {
      error: String(error?.message || error),
    })
    return 0
  }

  let cancelled = 0
  for (const task of rows || []) {
    cancelled += await cancelTaskFailClosed(db, task.id, reason)
  }
  return cancelled
}

async function loadTaskSource(db, table, id) {
  if (!id) return null
  // audit:allow dynamic-sql -- table is an internal literal at both call sites; id remains bound.
  return await db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(String(id))
}

async function hasSubmissionUncertainTask(db, profileId, row) {
  const statuses = [...SUBMISSION_UNCERTAIN_TASK_STATUSES]
  const placeholders = statuses.map(() => '?').join(', ')
  try {
    const task = await db.prepare(`
      SELECT id
        FROM application_tasks
       WHERE profile_id = ?
         AND ((grant_id IS NOT NULL AND grant_id = ?)
           OR (opportunity_id IS NOT NULL AND opportunity_id = ?))
         AND LOWER(COALESCE(status, '')) IN (${placeholders})
       LIMIT 1
    `).get(
      String(profileId),
      row?.grant_id ? String(row.grant_id) : null,
      row?.funding_opportunity_id ? String(row.funding_opportunity_id) : null,
      ...statuses,
    )
    return Boolean(task?.id)
  } catch (error) {
    // This predicate protects evidence around a possibly completed external
    // submission. A schema/query failure must stop cleanup, never be mistaken
    // for proof that no protected task exists.
    throw new Error('could not verify submission-uncertain task protection', { cause: error })
  }
}

/**
 * Audit every unfinished Hamilton task with the exact evaluator used before
 * creation. `enforce:false` is the read-only public metric; `enforce:true` is
 * the migration/boot reconciliation. Discovery is limit+1 so truncation can
 * never be reported as a healthy zero.
 */
export async function auditUnfinishedHamiltonTasks(db, {
  enforce = false,
  limit = 100000,
  now = new Date(),
  actor = 'system:hamilton-task-precision',
  profileId = null,
  assess = assessHamiltonFundingSource,
} = {}) {
  const out = {
    scanned: 0,
    valid: 0,
    invalid: 0,
    deferred: 0,
    protected: 0,
    failed: 0,
    repairFailed: 0,
    truncated: false,
    tasksCancelled: 0,
    matchesRemoved: 0,
    grantsRemoved: 0,
    tombstonesWritten: 0,
    byGate: {},
    byBucket: {},
    byReason: {},
  }
  const cap = Math.max(1, Number(limit) || 100000)
  const statuses = TASK_HISTORY_STATUSES.map(() => '?').join(', ')
  const params = [...TASK_HISTORY_STATUSES]
  let scope = ''
  if (profileId) {
    scope = ' AND profile_id = ?'
    params.push(String(profileId))
  }
  params.push(cap + 1)

  let tasks
  try {
    // audit:allow unscoped-profile-query -- the boot/public census is intentionally global and returns aggregate counts only.
    // audit:allow dynamic-sql -- status placeholders and the optional bound profile clause are built from internal constants.
    tasks = await db.prepare(`
      SELECT *
        FROM application_tasks
       WHERE LOWER(COALESCE(status, '')) NOT IN (${statuses})${scope}
       ORDER BY id
       LIMIT ?
    `).all(...params)
  } catch (error) {
    return { ...out, failed: 1, error: String(error?.message || error).slice(0, 180) }
  }
  if ((tasks || []).length > cap) {
    out.truncated = true
    tasks = tasks.slice(0, cap)
  }

  const factsByProfile = new Map()
  const cleanedSources = new Set()
  for (const task of tasks || []) {
    out.scanned += 1
    const taskProfileId = String(task?.profile_id || '')
    const taskStatus = String(task?.status || '').trim().toLowerCase()
    let classified = false
    try {
      // Submission-uncertain states are evidence-resolution work, not fresh
      // applications. An external side effect may already have happened, so
      // neither the task, its source/grant, nor its portal traces may be
      // rewritten by a funding-policy cleanup.
      if (SUBMISSION_UNCERTAIN_TASK_STATUSES.has(taskStatus)) {
        out.protected += 1
        classified = true
        continue
      }
      const grant = await loadTaskSource(db, 'grants', task?.grant_id)
      const opportunityId = task?.opportunity_id || grant?.funding_opportunity_id || null
      const opportunity = await loadTaskSource(db, 'funding_opportunities', opportunityId)
      let assessment
      const opportunityIsShareable = opportunity?.is_national === true
        || opportunity?.is_national === 1
        || opportunity?.is_national === '1'
      const missingLinkedSource = (task?.grant_id && !grant) || (task?.opportunity_id && !opportunity)
      const crossProfileGrant = grant?.profile_id && String(grant.profile_id) !== taskProfileId
      const crossProfileBareOpportunity = !grant
        && !opportunityIsShareable
        && opportunity?.profile_id
        && String(opportunity.profile_id) !== taskProfileId
      if (!taskProfileId || missingLinkedSource || crossProfileGrant || crossProfileBareOpportunity) {
        assessment = {
          ok: false,
          gate: 'source_scope',
          code: 'funding_source_profile_mismatch',
          reasons: [missingLinkedSource ? 'task_source_missing' : 'task_source_profile_mismatch'],
        }
      } else {
        if (!factsByProfile.has(taskProfileId)) {
          factsByProfile.set(taskProfileId, await loadProfileFacts(db, taskProfileId, { strict: true }))
        }
        const facts = factsByProfile.get(taskProfileId)
        // PromoPilot's Sasquatch fixture is a standing protected profile. Its
        // deliberately implausible work must remain available for demos/tests
        // and is excluded from production-readiness truth just like Robert's
        // canonical pipeline audit excludes it.
        if (facts?.protectedProfile) {
          out.protected += 1
          classified = true
          continue
        }
        assessment = await assess(db, {
          profileId: taskProfileId,
          opportunity,
          grant,
          profileFacts: facts,
          now,
        })
      }

      if (assessment.retryable) {
        out.deferred += 1
        classified = true
        const gate = String(assessment.gate || assessment.code || 'unknown')
        const reason = String(assessment.reasons?.[0] || assessment.code || 'retryable_policy_check')
        const bucket = bucketForTaskStatus(task?.status)
        out.byGate[gate] = (out.byGate[gate] || 0) + 1
        out.byBucket[bucket] = (out.byBucket[bucket] || 0) + 1
        out.byReason[reason] = (out.byReason[reason] || 0) + 1
        continue
      }
      if (assessment.unavailable) {
        throw new Error(`Hamilton policy unavailable: ${assessment.reasons?.[0] || assessment.code}`)
      }

      if (assessment.ok) {
        out.valid += 1
        classified = true
        continue
      }

      out.invalid += 1
      classified = true
      const gate = String(assessment.gate || assessment.code || 'unknown')
      const reason = String(assessment.reasons?.[0] || assessment.code || 'not_positively_verified')
      const bucket = bucketForTaskStatus(task?.status)
      out.byGate[gate] = (out.byGate[gate] || 0) + 1
      out.byBucket[bucket] = (out.byBucket[bucket] || 0) + 1
      out.byReason[reason] = (out.byReason[reason] || 0) + 1
      if (!enforce) continue

      const sourceKey = `${taskProfileId}:${opportunityId || ''}:${task?.grant_id || ''}`
      if (!cleanedSources.has(sourceKey)) {
        cleanedSources.add(sourceKey)
        const cleanup = await cleanupDisallowedHamiltonTraces(db, {
          profileId: taskProfileId,
          opportunityId,
          grantId: task?.grant_id || null,
          reason: `task_precision:${gate}:${reason}`,
        })
        out.tasksCancelled += finiteCount(cleanup?.cancelled_tasks)
        const sourceEvidenceProtected = cleanup?.protected_submission_evidence === true
        if (!sourceEvidenceProtected) {
          out.matchesRemoved += await removePersistedMatch(db, taskProfileId, opportunityId, { failClosed: true })
        }

        if (!sourceEvidenceProtected && grant && !isProtectedHistory(grant)) {
          await recordDismissal(db, {
            profileId: taskProfileId,
            grantRow: grant,
            opportunity,
            userId: actor,
            reason: `task_precision:${gate}:${reason}`,
          })
          out.tombstonesWritten += 1
          const deleted = await db.prepare('DELETE FROM grants WHERE id = ? AND profile_id = ?')
            .run(String(grant.id), taskProfileId)
          out.grantsRemoved += changesOf(deleted)
        } else if (!sourceEvidenceProtected && !grant && opportunity) {
          await recordDismissal(db, {
            profileId: taskProfileId,
            opportunity,
            userId: actor,
            reason: `task_precision:${gate}:${reason}`,
          })
          out.tombstonesWritten += 1
        }
      }

      // Cleanup helpers span rolling schema versions and intentionally make
      // nonessential trace removal best-effort. The task transition itself is
      // essential: verify it, so a swallowed UPDATE failure can never become a
      // green boot summary or a false zero in the readiness contract.
      let repairedTask = await db.prepare(
        'SELECT status FROM application_tasks WHERE id = ? LIMIT 1',
      ).get(String(task.id))
      const repairedStatus = String(repairedTask?.status || '').trim().toLowerCase()
      if (
        repairedTask
        && !TASK_HISTORY_STATUSES.includes(repairedStatus)
        && !SUBMISSION_UNCERTAIN_TASK_STATUSES.has(repairedStatus)
      ) {
        out.tasksCancelled += await cancelTaskFailClosed(
          db,
          task.id,
          `Hamilton task precision closed work that failed ${gate}: ${reason}`,
        )
        repairedTask = await db.prepare(
          'SELECT status FROM application_tasks WHERE id = ? LIMIT 1',
        ).get(String(task.id))
      }
      const finalStatus = String(repairedTask?.status || '').trim().toLowerCase()
      if (
        !repairedTask
        || (!TASK_HISTORY_STATUSES.includes(finalStatus)
          && !SUBMISSION_UNCERTAIN_TASK_STATUSES.has(finalStatus))
      ) {
        throw new Error(`task ${task.id} remained unfinished after precision cleanup`)
      }
    } catch (error) {
      if (classified) out.repairFailed += 1
      else out.failed += 1
      log.warn('Hamilton task precision audit failed', {
        taskId: task?.id,
        error: String(error?.message || error),
      })
    }
  }
  const accounted = out.valid + out.invalid + out.deferred + out.protected + out.failed
  if (accounted !== out.scanned) {
    out.failed += Math.abs(out.scanned - accounted) || 1
  }
  return out
}

/**
 * Refresh the cached task-truth read-back after the canonical recurring link
 * verifier has updated liveness evidence. This is deliberately narrower than
 * the boot pipeline sweep: it may advance only an already complete/readable
 * boot snapshot, and it never converts a failed or missing boot census green.
 */
export async function refreshHamiltonTaskTruthAfterLinkVerification(db, {
  limit = 100000,
  now = new Date(),
  actor = 'system:recurring-link-verification',
} = {}) {
  const prior = await readHamiltonTaskTruthSnapshot(db)
  if (!prior.available || !prior.queueReadable || !prior.cleanup) {
    throw new Error(`Hamilton task truth cannot refresh from boot status ${prior.status || 'unavailable'}`)
  }

  const taskRepairAudit = await auditUnfinishedHamiltonTasks(db, {
    enforce: true,
    limit,
    now,
    actor,
  })
  if (taskRepairAudit.failed > 0 || taskRepairAudit.repairFailed > 0 || taskRepairAudit.truncated) {
    throw new Error(
      `Hamilton link-refresh repair incomplete: failed=${taskRepairAudit.failed}, repair_failed=${taskRepairAudit.repairFailed}, truncated=${taskRepairAudit.truncated}`,
    )
  }

  const verificationTaskAudit = await auditUnfinishedHamiltonTasks(db, {
    enforce: false,
    limit,
    now,
    actor: `${actor}:readback`,
  })
  if (
    verificationTaskAudit.invalid > 0
    || verificationTaskAudit.failed > 0
    || verificationTaskAudit.repairFailed > 0
    || verificationTaskAudit.truncated
  ) {
    throw new Error(
      `Hamilton link-refresh verification incomplete: invalid=${verificationTaskAudit.invalid}, failed=${verificationTaskAudit.failed}, repair_failed=${verificationTaskAudit.repairFailed}, truncated=${verificationTaskAudit.truncated}`,
    )
  }

  const deferred = Math.max(
    Number(taskRepairAudit.deferred || 0),
    Number(verificationTaskAudit.deferred || 0),
  )
  const summary = {
    timestamp: new Date().toISOString(),
    status: deferred > 0 ? 'pending_reverification' : 'verified',
    scanned: prior.cleanup.scanned,
    kept: prior.cleanup.kept,
    removed: prior.cleanup.removed,
    relabeled: prior.cleanup.relabeled,
    deferred,
    tasksCancelled: prior.cleanup.tasksCancelled + Number(taskRepairAudit.tasksCancelled || 0),
    matchesRemoved: prior.cleanup.matchesRemoved + Number(taskRepairAudit.matchesRemoved || 0),
    failed: 0,
    truncated: false,
    profiles: prior.cleanup.profiles,
    profilesAffected: prior.cleanup.profilesAffected,
    byGate: prior.cleanup.byGate,
    taskRepairAudit,
    taskAudit: verificationTaskAudit,
    verificationTaskAudit,
  }
  await persistHamiltonTaskTruthSnapshot(db, summary)
  return summary
}

function finiteCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function removePersistedMatch(db, profileId, opportunityId, { failClosed = false } = {}) {
  if (!opportunityId) return 0
  try {
    const result = await db.prepare(
      'DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?',
    ).run(String(profileId), String(opportunityId))
    return changesOf(result)
  } catch (error) {
    if (failClosed) throw error
    return 0
  }
}

async function relabelProtectedHistory(db, row, tag) {
  let reasons = []
  try {
    const current = await db.prepare(
      'SELECT ineligibility_reasons FROM grants WHERE id = ?',
    ).get(row.grant_id)
    const raw = current?.ineligibility_reasons
    reasons = Array.isArray(raw) ? raw : JSON.parse(raw || '[]')
  } catch {
    reasons = []
  }
  if (!Array.isArray(reasons)) reasons = []
  if (!reasons.includes(tag)) reasons.push(tag)

  const result = await db.prepare(`
    UPDATE grants
       SET eligibility_status = 'ineligible',
           match_decision = 'REJECT',
           ineligibility_reasons = ?
     WHERE id = ?
  `).run(JSON.stringify(reasons), row.grant_id)
  if (changesOf(result) !== 1) {
    throw new Error(`protected grant ${row.grant_id} was not relabeled`)
  }
}

async function persistSummary(db, summary) {
  try {
    await persistHamiltonTaskTruthSnapshot(db, summary)
  } catch (error) {
    log.warn('strict reconciliation summary could not be persisted', {
      error: String(error?.message || error),
    })
  }
}

export async function runStrictPipelineReconciliation(db, {
  limit = 100000,
  now = new Date(),
  actor = 'production-migration:strict-four-gates',
} = {}) {
  const result = {
    scanned: 0,
    kept: 0,
    removed: 0,
    relabeled: 0,
    tasksCancelled: 0,
    matchesRemoved: 0,
    deferred: 0,
    failed: 0,
    truncated: false,
    profiles: 0,
    profilesAffected: 0,
    byGate: {},
    byReason: {},
    errors: [],
  }

  const affected = new Set()
  const profileIds = await activeProfileIds(db)
  result.profiles = profileIds.length

  for (const profileId of profileIds) {
    let facts
    let rows
    try {
      facts = await loadProfileFacts(db, profileId, { strict: true })
      if (!facts?.profile || facts.protectedProfile) continue
      rows = await pipelineRowsIncludingLegacyLeads(db, profileId)
    } catch (error) {
      result.failed += 1
      result.errors.push(`profile:${profileId}:${String(error?.message || error).slice(0, 160)}`)
      continue
    }

    for (const row of rows) {
      if (result.scanned >= limit) {
        result.truncated = true
        break
      }
      result.scanned += 1

      try {
        const assessment = await assessHamiltonFundingSource(db, {
          profileId,
          opportunity: row,
          grant: { ...row, id: row.grant_id, status: row.grant_status },
          profileFacts: facts,
          now,
        })
        if (assessment.retryable) {
          const reason = String(assessment.reasons?.[0] || assessment.code || 'retryable_policy_check')
          const gate = String(assessment.gate || assessment.code || 'unknown')
          result.deferred += 1
          result.byGate[gate] = (result.byGate[gate] || 0) + 1
          result.byReason[`strict_pipeline:${gate}:${reason}`] =
            (result.byReason[`strict_pipeline:${gate}:${reason}`] || 0) + 1
          continue
        }
        if (assessment.unavailable) {
          throw new Error(`Hamilton policy unavailable: ${assessment.reasons?.[0] || assessment.code}`)
        }
        if (assessment.ok) {
          result.kept += 1
          continue
        }

        const reason = String(assessment.reasons?.[0] || assessment.code || 'not_positively_verified')
        const gate = String(assessment.gate || assessment.code || 'unknown')
        const tag = `strict_pipeline:${gate}:${reason}`
        result.byGate[gate] = (result.byGate[gate] || 0) + 1
        result.byReason[tag] = (result.byReason[tag] || 0) + 1
        affected.add(profileId)

        // Submission evidence outranks cleanup. Preserve the grant, source,
        // portal links, and task while clearly relabeling the grant so it can
        // never seed new work. The task audit below counts the evidence hold as
        // protected rather than trying to force it into terminal history.
        if (await hasSubmissionUncertainTask(db, profileId, row)) {
          await relabelProtectedHistory(db, row, tag)
          result.relabeled += 1
          continue
        }

        result.tasksCancelled += await cancelActiveTasks(
          db,
          profileId,
          row,
          `Pipeline precision closed this task because the funding source failed ${gate}: ${reason}`,
        )
        result.matchesRemoved += await removePersistedMatch(
          db,
          profileId,
          row.funding_opportunity_id,
          { failClosed: true },
        )

        if (isProtectedHistory(row)) {
          await relabelProtectedHistory(db, row, tag)
          result.relabeled += 1
          continue
        }

        await recordDismissal(db, {
          profileId,
          grantRow: {
            id: row.grant_id,
            profile_id: profileId,
            funding_opportunity_id: row.funding_opportunity_id,
            title: row.title,
            funder: row.funder,
            deadline: row.deadline,
            application_url: row.application_url,
            source_url: row.source_url,
          },
          userId: actor,
          reason: tag,
        })
        const deleted = await db.prepare('DELETE FROM grants WHERE id = ? AND profile_id = ?')
          .run(row.grant_id, profileId)
        if (changesOf(deleted) !== 1) {
          throw new Error(`grant ${row.grant_id} was not deleted`)
        }
        result.removed += 1
      } catch (error) {
        result.failed += 1
        if (result.errors.length < 20) {
          result.errors.push(`grant:${row?.grant_id || 'unknown'}:${String(error?.message || error).slice(0, 180)}`)
        }
      }
    }
    if (result.truncated) break
  }

  result.profilesAffected = affected.size
  const accounted = result.kept + result.removed + result.relabeled + result.deferred + result.failed
  if (accounted !== result.scanned) {
    throw new Error(`strict pipeline accounting mismatch: scanned=${result.scanned}, accounted=${accounted}`)
  }

  const taskAudit = await auditUnfinishedHamiltonTasks(db, {
    enforce: true,
    limit,
    now,
    actor,
  })
  result.tasksCancelled += taskAudit.tasksCancelled
  result.matchesRemoved += taskAudit.matchesRemoved
  result.taskAudit = taskAudit

  const summary = {
    timestamp: new Date().toISOString(),
    // The migration repairs durable rows but the boot invariant performs the
    // independent read-back census. Never label a migration-only snapshot as a
    // verified queue contract.
    status: 'migration_reconciled',
    ...result,
    errors: result.errors.slice(0, 5),
  }
  await persistSummary(db, summary)

  if (result.truncated || result.failed > 0 || taskAudit.truncated || taskAudit.failed > 0 || taskAudit.repairFailed > 0) {
    const error = new Error(
      `strict pipeline reconciliation incomplete: failed=${result.failed}, truncated=${result.truncated}, task_failed=${taskAudit.failed}, task_repair_failed=${taskAudit.repairFailed}, task_truncated=${taskAudit.truncated}`,
    )
    error.result = result
    throw error
  }

  log.info('strict pipeline reconciliation completed', summary)
  return result
}

export default runStrictPipelineReconciliation
