/**
 * Bounded, non-destructive repair for legacy Hamilton tasks whose only source
 * is a pointer (directory/referral/school portal/past-award intel) with no
 * reachable application/listing URL.
 *
 * The create-time choke point lives in applicationTaskStore. This repair uses
 * that exact assessment, preserves every document/evidence field, disables
 * submission intent, records a durable audit summary, and appends an event.
 */

import { pointerKindSql } from '../../config/opportunityKindClasses.js'
import {
  appendTaskEvent,
  assessApplicationTaskPointerSource,
} from './applicationTaskStore.js'

export const POINTER_TASK_REPAIR_VERSION = 'pointer-task-repair-v1'

// What this set protects is SUBMISSION EVIDENCE — a row that already recorded
// an outcome, or one sitting on the submit boundary where a rewrite could
// destroy proof. `failed` was in here and does not belong (2026-08-14): a
// FAILED pointer task is exactly the population this module exists for — a row
// with no application surface that already died silently, carrying no evidence
// to protect. Excluding it meant the tasks most in need of a
// `blocked` / `no_application_surface` handoff with real instructions were
// counted `protected_terminal` and left holding a stale, non-actionable
// message forever. The sibling policy module's terminal set
// (`hamiltonFundingSourcePolicy`) is `submitted/completed/cancelled` only.
const PROTECTED_TASK_STATUSES = new Set([
  'submitted',
  'completed',
  'cancelled',
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
])

function boundedInteger(value, fallback, { min = 1, max = 5000 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function changesOf(result) {
  const count = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(count) ? count : 0
}

function safeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value }
  if (!value) return {}
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function isMissingRepairSchema(error) {
  const message = String(error?.message || error).toLowerCase()
  return (
    /no such table/.test(message)
    || /no such column/.test(message)
    || /relation .* does not exist/.test(message)
    || /column .* does not exist/.test(message)
    || ['42P01', '42703'].includes(String(error?.code || ''))
  )
}

/**
 * Repair legacy rows without deleting the task or any submission/document
 * evidence. `limit` bounds writes; `scanLimit` bounds discovery and the return
 * counters explicitly report anything deferred by either bound.
 */
export async function repairLegacyPointerApplicationTasks(db, {
  limit = 500,
  scanLimit = 5000,
  dryRun = false,
  actorUserId = null,
  actorRole = 'system',
} = {}) {
  const writeLimit = boundedInteger(limit, 500, { max: 5000 })
  const boundedScanLimit = boundedInteger(scanLimit, 5000, { max: 10000 })

  let rows
  try {
    rows = await db.prepare(
      `SELECT t.id, t.profile_id, t.opportunity_id, t.grant_id,
              t.automation_type, t.status, t.current_step,
              t.portal_url, t.application_url, t.audit_summary_json,
              t.output_document_id, t.output_pdf_document_id,
              t.output_docx_document_id, t.output_proposal_document_id,
              fo.id AS policy_opportunity_id,
              fo.opportunity_kind AS policy_opportunity_kind,
              fo.title AS policy_opportunity_title
         FROM application_tasks t
         LEFT JOIN grants g
           ON g.id = t.grant_id
          AND (g.profile_id = t.profile_id OR g.profile_id IS NULL)
         JOIN funding_opportunities fo
           ON fo.id = COALESCE(g.funding_opportunity_id, t.opportunity_id)
        WHERE ${pointerKindSql('fo.opportunity_kind')}
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT ?`,
    ).all(boundedScanLimit)
  } catch (error) {
    if (isMissingRepairSchema(error)) {
      return {
        scanned: 0,
        non_applyable: 0,
        applyable: 0,
        would_repair: 0,
        repaired: 0,
        protected_terminal: 0,
        already_repaired: 0,
        conflicts: 0,
        audit_event_failures: 0,
        deferred_by_limit: 0,
        scan_limit_reached: false,
        skipped: 'schema_unavailable',
      }
    }
    throw error
  }

  const report = {
    scanned: rows.length,
    non_applyable: 0,
    applyable: 0,
    would_repair: 0,
    repaired: 0,
    protected_terminal: 0,
    already_repaired: 0,
    source_scope_errors: 0,
    conflicts: 0,
    audit_event_failures: 0,
    deferred_by_limit: 0,
    scan_limit_reached: rows.length === boundedScanLimit,
    dry_run: Boolean(dryRun),
    repair_version: POINTER_TASK_REPAIR_VERSION,
  }
  const repairable = []

  for (const row of rows) {
    let lead
    try {
      lead = await assessApplicationTaskPointerSource(db, {
        profileId: row.profile_id,
        opportunityId: row.opportunity_id,
        grantId: row.grant_id,
        applicationUrl: row.application_url,
        portalUrl: row.portal_url,
      })
    } catch (error) {
      // A cross-profile source link is not safe to adjudicate here. Surface it
      // separately; another tenancy invariant owns that corruption class.
      if (error?.code === 'application_task_source_scope_mismatch') {
        report.source_scope_errors += 1
        continue
      }
      throw error
    }

    if (!lead) {
      report.applyable += 1
      continue
    }
    report.non_applyable += 1

    const status = String(row.status || '').trim().toLowerCase()
    if (
      String(row.automation_type || '').trim().toLowerCase() === 'research_lead'
      && status === 'blocked'
      && String(row.current_step || '') === 'no_application_surface'
    ) {
      report.already_repaired += 1
      continue
    }
    if (PROTECTED_TASK_STATUSES.has(status)) {
      report.protected_terminal += 1
      continue
    }
    repairable.push({ row, lead })
  }

  report.would_repair = repairable.length
  const selected = repairable.slice(0, writeLimit)
  report.deferred_by_limit = repairable.length - selected.length
  if (dryRun) return report

  for (const { row, lead } of selected) {
    const repairedAt = new Date().toISOString()
    const auditSummary = safeObject(row.audit_summary_json)
    auditSummary.pointer_research_lead_repair = {
      version: POINTER_TASK_REPAIR_VERSION,
      repaired_at: repairedAt,
      previous_status: row.status ?? null,
      previous_automation_type: row.automation_type ?? null,
      opportunity_id: row.policy_opportunity_id ?? row.opportunity_id ?? null,
      opportunity_kind: row.policy_opportunity_kind ?? lead.kind ?? null,
      evidence_preserved: true,
      submission_intent_disabled: true,
    }

    const result = await db.prepare(
      `UPDATE application_tasks
          SET automation_type = 'research_lead',
              status = 'blocked',
              current_step = 'no_application_surface',
              last_agent_message = ?,
              auto_submit_enabled = FALSE,
              allow_auto_submit = FALSE,
              next_retry_at = NULL,
              audit_summary_json = ?,
              updated_at = ${nowSqlLiteral(db)}
        WHERE id = ?
          AND COALESCE(status, '') = COALESCE(?, '')
          AND COALESCE(automation_type, '') = COALESCE(?, '')`,
    ).run(
      lead.instructions,
      JSON.stringify(auditSummary),
      String(row.id),
      row.status ?? null,
      row.automation_type ?? null,
    )

    if (changesOf(result) !== 1) {
      report.conflicts += 1
      continue
    }
    report.repaired += 1

    try {
      await appendTaskEvent(db, {
        taskId: row.id,
        eventType: 'blocked',
        status: 'blocked',
        step: 'no_application_surface',
        message: lead.instructions,
        actorUserId,
        actorRole,
        details: {
          invariant: POINTER_TASK_REPAIR_VERSION,
          reason: 'pointer_research_lead',
          previous_status: row.status ?? null,
          previous_automation_type: row.automation_type ?? null,
          opportunity_id: row.policy_opportunity_id ?? row.opportunity_id ?? null,
          opportunity_kind: row.policy_opportunity_kind ?? lead.kind ?? null,
          evidence_preserved: true,
          output_document_ids: [
            row.output_document_id,
            row.output_pdf_document_id,
            row.output_docx_document_id,
            row.output_proposal_document_id,
          ].filter(Boolean),
        },
      })
    } catch {
      // The task row's audit_summary_json already carries the durable repair
      // receipt. Reconcile this count rather than rolling back the safe block.
      report.audit_event_failures += 1
    }
  }

  return report
}

export default {
  POINTER_TASK_REPAIR_VERSION,
  repairLegacyPointerApplicationTasks,
}
