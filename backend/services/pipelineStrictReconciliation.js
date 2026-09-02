import { createLogger } from '../utils/logger.js'
import { cleanExtractedText } from '../utils/htmlTextHygiene.js'
import { evaluateApplicantTypeEligibility } from './applicantTypeGate.js'
import {
  buildPipelineRowSql,
  loadProfileFacts,
  gateRelatable,
  gateQualifies,
  gateCoversNeed,
  gateRealOffline,
  PROTECTED_GRANT_STATUSES,
} from './robert/robertPipelineAudit.js'
import { recordDismissal } from './pipelineDismissals.js'
import { cancelApplicationTask } from './hamilton/applicationTaskStore.js'

const log = createLogger('pipeline-strict-reconciliation')

const POSITIVE_LINK_STATUSES = new Set([
  'ok', 'redirect', 'verified', 'alive', 'live', 'valid', 'active', 'reachable',
  'success', '200',
])

const TASK_HISTORY_STATUSES = Object.freeze([
  'submitted', 'completed', 'complete', 'done', 'cancelled', 'canceled',
  'archived', 'rejected', 'closed', 'submit_attempt_started',
  'submit_evidence_pending', 'submission_verification_required',
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

function positiveApplicantProof(row, facts) {
  const verdict = evaluateApplicantTypeEligibility(row, facts?.applicantType, {
    profile: facts?.profile,
    sections: facts?.sections,
  })
  const pass =
    verdict?.decision === 'pass'
    && verdict?.reason === 'explicit_applicant_types_match'
  return {
    pass,
    reason: pass
      ? null
      : `applicant_type:${verdict?.reason || verdict?.decision || 'not_positively_verified'}`,
    evidence: verdict ?? null,
  }
}

function positiveRealityProof(row, now) {
  const offline = gateRealOffline(row, { now })
  if (offline?.pass === false) return offline
  const status = String(row?.link_status || '').trim().toLowerCase()
  if (!POSITIVE_LINK_STATUSES.has(status)) {
    return {
      pass: false,
      reason: `real:link_not_positively_verified:${status || 'missing'}`,
      evidence: { link_status: status || null },
    }
  }
  return {
    pass: true,
    reason: null,
    evidence: { link_status: status },
  }
}

function evaluateFourPositiveGates(row, facts, now) {
  const relatable = gateRelatable(row, { now })
  if (!relatable.pass) {
    return { pass: false, gate: 'relatable', reason: relatable.reason, evidence: relatable.evidence }
  }

  const applicant = positiveApplicantProof(row, facts)
  if (!applicant.pass) {
    return { pass: false, gate: 'qualifies', reason: applicant.reason, evidence: applicant.evidence }
  }

  const qualifies = gateQualifies(row, facts)
  if (!qualifies.pass) {
    return { pass: false, gate: 'qualifies', reason: qualifies.reason, evidence: qualifies.evidence }
  }

  const covers = gateCoversNeed(row, facts)
  if (!covers.pass || !Array.isArray(covers?.evidence?.matched) || covers.evidence.matched.length === 0) {
    return {
      pass: false,
      gate: 'covers_need',
      reason: covers.reason || 'covers_need:no_positive_declared_match',
      evidence: covers.evidence,
    }
  }

  const real = positiveRealityProof(row, now)
  if (!real.pass) {
    return { pass: false, gate: 'real', reason: real.reason, evidence: real.evidence }
  }

  return {
    pass: true,
    gates: {
      relatable: relatable.evidence,
      qualifies: { applicant: applicant.evidence, canonical: qualifies.evidence },
      covers_need: covers.evidence,
      real: real.evidence,
    },
  }
}

function isProtectedHistory(row) {
  const status = String(row?.grant_status || '').trim().toLowerCase()
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
    const placeholders = TASK_HISTORY_STATUSES.map(() => '?').join(', ')
    rows = await db.prepare(`
      SELECT id
        FROM application_tasks
       WHERE profile_id = ?
         AND ((grant_id IS NOT NULL AND grant_id = ?)
           OR (opportunity_id IS NOT NULL AND opportunity_id = ?))
         AND LOWER(COALESCE(status, '')) NOT IN (${placeholders})
    `).all(...pairParams, ...TASK_HISTORY_STATUSES)
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
  const placeholders = TASK_HISTORY_STATUSES.map(() => '?').join(', ')
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
    `).all(...TASK_HISTORY_STATUSES)
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

async function removePersistedMatch(db, profileId, opportunityId) {
  if (!opportunityId) return 0
  try {
    const result = await db.prepare(
      'DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?',
    ).run(String(profileId), String(opportunityId))
    return changesOf(result)
  } catch {
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
    const now = new Date().toISOString()
    await db.prepare(`
      INSERT INTO system_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('pipeline_precision_last_run', JSON.stringify(summary), now)
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
      facts = await loadProfileFacts(db, profileId)
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
        const verdict = evaluateFourPositiveGates(row, facts, now)
        if (verdict.pass) {
          result.kept += 1
          continue
        }

        const reason = String(verdict.reason || 'not_positively_verified')
        const gate = String(verdict.gate || 'unknown')
        const tag = `strict_pipeline:${gate}:${reason}`
        result.byGate[gate] = (result.byGate[gate] || 0) + 1
        result.byReason[tag] = (result.byReason[tag] || 0) + 1
        affected.add(profileId)

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

  // Reconcile tasks orphaned by earlier partial passes too. A task can outlive
  // the grant row that made the original pair-scoped cancellation discoverable.
  result.tasksCancelled += await cancelInvalidActiveHamiltonTasks(db)

  result.profilesAffected = affected.size
  const accounted = result.kept + result.removed + result.relabeled + result.failed
  if (accounted !== result.scanned) {
    throw new Error(`strict pipeline accounting mismatch: scanned=${result.scanned}, accounted=${accounted}`)
  }

  const summary = {
    timestamp: new Date().toISOString(),
    ...result,
    errors: result.errors.slice(0, 5),
  }
  await persistSummary(db, summary)

  if (result.truncated || result.failed > 0) {
    const error = new Error(
      `strict pipeline reconciliation incomplete: failed=${result.failed}, truncated=${result.truncated}`,
    )
    error.result = result
    throw error
  }

  log.info('strict pipeline reconciliation completed', summary)
  return result
}

export default runStrictPipelineReconciliation
