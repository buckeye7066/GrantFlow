/**
 * applicationTaskStore.js
 *
 * Persistence helpers for `application_tasks`, `application_task_events`,
 * and `application_missing_info`. Used by both the Hamilton agent and the
 * /api/application-tasks routes.
 *
 * Mission rules:
 *   - Profile-scoped: every read accepts (profileId or admin context) and
 *     callers must verify access before mutating.
 *   - Append-only audit log (mission rule "any new logic must be
 *     traceable / logged / reversible"): event rows are never updated or
 *     deleted; cancellation is a status transition, not a row removal.
 *   - Idempotent schema bootstrap so unit tests using fresh in-memory DBs
 *     don't have to load the migration file.
 */

import crypto from 'crypto'
import { withProfileScope } from '../../middleware/profileContext.js'
import { parseFullName } from '../../../shared/nameParsing.js'
import { normalizeFafsaStatus, deriveFafsaCompleted } from '../college/fafsaStatus.js'

export const TASK_STATUSES = Object.freeze([
  // Legacy task statuses (per-grant Hamilton flow).
  'queued',
  'ready',
  'waiting_for_user',
  'waiting_for_admin',
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
  'in_progress',
  'draft_completed',
  'submitted',
  'failed',
  'cancelled',
  // Automation-task extension (migration 087). The select-many
  // "Automate with Hamilton" flow drives tasks through this richer state
  // machine. The legacy statuses above remain valid so existing
  // per-grant Hamilton cycles keep working unchanged.
  'analyzing',
  'ready_to_start',
  'generating_application',
  'generating_documents',
  'saving_documents',
  'launching_portal',
  'waiting_for_login',
  'waiting_for_2fa',
  'waiting_for_captcha',
  // Account created on a portal but the email still needs verifying. The user's
  // ONE step (click the link in the email); Hamilton auto-resumes once verified.
  // Re-picked by hamiltonAgentAdapter on the auth-backoff cadence, exactly like
  // the other waiting_for_* auth states. The Postgres status CHECK constraint is
  // driven from THIS list by ensureApplicationTaskSchema, so adding it here also
  // syncs the boot self-heal (no separate migration needed).
  'waiting_for_email_verification',
  'waiting_for_window',
  'waiting_for_missing_info',
  'filling_portal',
  'saving_portal_draft',
  'waiting_for_review',
  'ready_to_submit',
  'ready_to_print_mail',
  'ready_to_email',
  'ready_to_fax',
  'completed',
  'blocked',
])

export const AUTOMATION_TYPES = Object.freeze([
  'portal',
  'pdf_docx',
  'mail',
  'fax',
  'email',
  'no_application',
  'auto_profile',
  'unknown',
])

export const TASK_BLOCKED_STATUSES = Object.freeze([
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
])

export const TASK_TERMINAL_STATUSES = Object.freeze([
  'submitted',
  'failed',
  'cancelled',
])

export const MISSING_INFO_KINDS = Object.freeze([
  'field',
  'document',
  'login',
  'consent',
  'signature',
  'attestation',
  'admin_review',
  'other',
])

export const TASK_EVENT_TYPES = Object.freeze([
  'created',
  'started',
  'progress',
  'fields_filled',
  'missing_info',
  'blocked',
  'unblocked',
  'draft_completed',
  'submitted',
  'cancelled',
  'failed',
  'note',
])

let ensuredSchema = false

export function _resetSchemaCache() {
  ensuredSchema = false
}

export async function ensureApplicationTaskSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredSchema) return

  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const defFalse = isPostgres ? 'FALSE' : '0'

  const jsonbType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyJsonObject = isPostgres ? `'{}'::jsonb` : `'{}'`

  await db.exec(`
    CREATE TABLE IF NOT EXISTS application_tasks (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      grant_id TEXT,
      portal_id TEXT,
      application_id TEXT,
      university_application_id TEXT,
      assigned_agent TEXT NOT NULL DEFAULT 'hamilton',
      agent_persona_version TEXT NOT NULL DEFAULT 'hamilton-mba-2026',
      automation_type TEXT NOT NULL DEFAULT 'unknown',
      selected_from_stage TEXT,
      current_pipeline_stage TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step TEXT,
      portal_url TEXT,
      application_url TEXT,
      output_document_id TEXT,
      output_pdf_document_id TEXT,
      output_docx_document_id TEXT,
      output_proposal_document_id TEXT,
      mailing_instructions_json ${jsonbType} NOT NULL DEFAULT ${emptyJsonObject},
      audit_summary_json ${jsonbType} NOT NULL DEFAULT ${emptyJsonObject},
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      missing_documents_json TEXT NOT NULL DEFAULT '[]',
      required_user_actions_json TEXT NOT NULL DEFAULT '[]',
      last_agent_message TEXT,
      auto_submit_enabled ${boolType} NOT NULL DEFAULT ${defFalse},
      allow_auto_submit ${boolType} NOT NULL DEFAULT ${defFalse},
      started_at ${tsType},
      submitted_at ${tsType},
      completed_at ${tsType},
      cancelled_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_tasks_profile ON application_tasks(profile_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_user    ON application_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_opp     ON application_tasks(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_grant   ON application_tasks(grant_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_status  ON application_tasks(status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_application_tasks_profile_subject
      ON application_tasks(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

    CREATE TABLE IF NOT EXISTS application_task_events (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT,
      step TEXT,
      message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      actor_user_id TEXT,
      actor_role TEXT,
      created_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_task_events_task    ON application_task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_application_task_events_type    ON application_task_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_application_task_events_created ON application_task_events(created_at);

    CREATE TABLE IF NOT EXISTS application_missing_info (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT,
      description TEXT,
      required ${boolType} NOT NULL DEFAULT 1,
      resolved ${boolType} NOT NULL DEFAULT ${defFalse},
      resolved_at ${tsType},
      resolved_by TEXT,
      resolved_value_json TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_task ON application_missing_info(task_id);
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_kind ON application_missing_info(kind);
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_resolved ON application_missing_info(resolved);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_application_missing_info_task_kind_key
      ON application_missing_info(task_id, kind, key);
  `)

  // Resync the Postgres status CHECK constraint to the current TASK_STATUSES.
  // The constraint is created by migrations, and this prod DB drifted to an
  // older, smaller status list (migration 087's expansion never applied), so
  // advancing a task to a new-state-machine status like 'analyzing' /
  // 'generating_application' threw `application_tasks_status_check` violations —
  // Hamilton could not create OR progress ANY task. Driving the constraint from
  // TASK_STATUSES (the single source of truth the JS layer already validates
  // against) makes it self-healing and drift-proof. SQLite local DBs create the
  // table without this constraint, so it's Postgres-only.
  if (isPostgres) {
    const statusList = TASK_STATUSES.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ')
    try {
      await db.exec(`ALTER TABLE application_tasks DROP CONSTRAINT IF EXISTS application_tasks_status_check`)
      await db.exec(`ALTER TABLE application_tasks ADD CONSTRAINT application_tasks_status_check CHECK (status IN (${statusList}))`)
    } catch (err) {
      // Tolerate concurrent-boot races re-adding the same constraint.
      if (!/already exists|does not exist/i.test(String(err?.message || err))) throw err
    }
  }

  // Upgrade legacy shape (pre-migration 087) to the automation-task
  // shape. Each ALTER is wrapped in a try/catch so a re-run on an
  // already-upgraded DB is a no-op. We never DROP anything — the
  // legacy columns and statuses remain valid.
  const ensureColumn = async (col, type, defaultLiteral = null) => {
    try {
      const def = defaultLiteral ? ` DEFAULT ${defaultLiteral}` : ''
      await db.exec(`ALTER TABLE application_tasks ADD COLUMN ${col} ${type}${def}`)
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase()
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        if (process.env.NODE_ENV !== 'test') console.warn(`[applicationTaskStore] ALTER TABLE ${col} failed: ${err?.message || err}`)
      }
    }
  }
  await ensureColumn('automation_type', 'TEXT', "'unknown'")
  await ensureColumn('selected_from_stage', 'TEXT')
  await ensureColumn('current_pipeline_stage', 'TEXT')
  await ensureColumn('agent_persona_version', 'TEXT', "'hamilton-mba-2026'")
  await ensureColumn('portal_url', 'TEXT')
  await ensureColumn('application_url', 'TEXT')
  await ensureColumn('university_application_id', 'TEXT')
  await ensureColumn('output_document_id', 'TEXT')
  await ensureColumn('output_pdf_document_id', 'TEXT')
  await ensureColumn('output_docx_document_id', 'TEXT')
  // Full MBA-level proposal doc (hamiltonFullProposalGenerator) attached to
  // the task alongside the submission packet. Ensured here at the single
  // application_tasks schema choke point (re-run on boot by
  // ensureSchemaInvariants → ensureApplicationTaskCheck), so both dialects
  // gain it without a separate migration.
  await ensureColumn('output_proposal_document_id', 'TEXT')
  await ensureColumn('mailing_instructions_json', isPostgres ? 'JSONB' : 'TEXT', isPostgres ? `'{}'::jsonb` : `'{}'`)
  await ensureColumn('audit_summary_json', isPostgres ? 'JSONB' : 'TEXT', isPostgres ? `'{}'::jsonb` : `'{}'`)
  await ensureColumn('allow_auto_submit', boolType, defFalse)
  await ensureColumn('started_at', tsType)
  await ensureColumn('completed_at', tsType)
  // Auth backup plan: auto-retry scheduling for login/2FA/captcha-blocked tasks.
  await ensureColumn('next_retry_at', tsType)
  await ensureColumn('retry_count', 'INTEGER', '0')

  ensuredSchema = true
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

function rowToTask(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id ?? null,
    grant_id: row.grant_id ?? null,
    portal_id: row.portal_id ?? null,
    application_id: row.application_id ?? null,
    university_application_id: row.university_application_id ?? null,
    assigned_agent: row.assigned_agent ?? 'hamilton',
    agent_persona_version: row.agent_persona_version ?? 'hamilton-mba-2026',
    automation_type: row.automation_type ?? 'unknown',
    selected_from_stage: row.selected_from_stage ?? null,
    current_pipeline_stage: row.current_pipeline_stage ?? null,
    status: row.status,
    current_step: row.current_step ?? null,
    portal_url: row.portal_url ?? null,
    application_url: row.application_url ?? null,
    output_document_id: row.output_document_id ?? null,
    output_pdf_document_id: row.output_pdf_document_id ?? null,
    output_docx_document_id: row.output_docx_document_id ?? null,
    output_proposal_document_id: row.output_proposal_document_id ?? null,
    mailing_instructions: safeJson(row.mailing_instructions_json, {}),
    audit_summary: safeJson(row.audit_summary_json, {}),
    missing_fields: safeJson(row.missing_fields_json, []),
    missing_documents: safeJson(row.missing_documents_json, []),
    required_user_actions: safeJson(row.required_user_actions_json, []),
    last_agent_message: row.last_agent_message ?? null,
    auto_submit_enabled: Boolean(row.auto_submit_enabled),
    allow_auto_submit: Boolean(row.allow_auto_submit),
    started_at: row.started_at ?? null,
    submitted_at: row.submitted_at ?? null,
    completed_at: row.completed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    next_retry_at: row.next_retry_at ?? null,
    retry_count: Number(row.retry_count) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    event_type: row.event_type,
    status: row.status ?? null,
    step: row.step ?? null,
    message: row.message ?? null,
    details: safeJson(row.details_json, {}),
    actor_user_id: row.actor_user_id ?? null,
    actor_role: row.actor_role ?? null,
    created_at: row.created_at,
  }
}

function rowToMissing(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    kind: row.kind,
    key: row.key,
    label: row.label ?? null,
    description: row.description ?? null,
    required: Boolean(row.required),
    resolved: Boolean(row.resolved),
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
    resolved_value: safeJson(row.resolved_value_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Create or fetch the existing task for a (profile, opportunity-or-grant).
 * The unique key in the schema makes repeated calls safe — they return
 * the existing row.
 */
export async function ensureApplicationTask(db, {
  profileId,
  userId = null,
  opportunityId = null,
  grantId = null,
  portalId = null,
  applicationId = null,
  universityApplicationId = null,
  automationType = 'unknown',
  selectedFromStage = null,
  currentPipelineStage = null,
  agentPersonaVersion = 'hamilton-mba-2026',
  initialStatus = 'queued',
  currentStep = null,
  // Effective batch auto-submit option (options.allow_auto_submit on
  // automateSelected). Persisted so the stored allow_auto_submit column
  // reflects runtime truth instead of silently staying at its FALSE default.
  // `undefined` = caller did not specify → leave the stored value untouched.
  allowAutoSubmit = undefined,
} = {}) {
  if (!profileId) throw new Error('profileId required')
  if (!opportunityId && !grantId) throw new Error('opportunityId or grantId required')
  if (!TASK_STATUSES.includes(initialStatus)) {
    throw new Error(`invalid initialStatus: ${initialStatus}`)
  }
  if (!AUTOMATION_TYPES.includes(automationType)) {
    throw new Error(`invalid automationType: ${automationType}`)
  }
  await ensureApplicationTaskSchema(db)

  return await withProfileScope({ bypass: true }, async () => {
    const existing = await db
      .prepare(
        `SELECT * FROM application_tasks
          WHERE profile_id = ? AND COALESCE(opportunity_id,'') = ? AND COALESCE(grant_id,'') = ?
          LIMIT 1`,
      )
      .get(
        String(profileId),
        opportunityId ? String(opportunityId) : '',
        grantId ? String(grantId) : '',
      )
    if (existing) {
      // Re-bump the automation metadata when the user re-selects the
      // same source from a different stage so the task picks up the
      // latest classification + selected-from-stage.
      const patch = []
      const params = []
      if (automationType && automationType !== 'unknown' && existing.automation_type !== automationType) {
        patch.push('automation_type = ?'); params.push(automationType)
      }
      if (selectedFromStage && existing.selected_from_stage !== selectedFromStage) {
        patch.push('selected_from_stage = ?'); params.push(selectedFromStage)
      }
      if (currentPipelineStage && existing.current_pipeline_stage !== currentPipelineStage) {
        patch.push('current_pipeline_stage = ?'); params.push(currentPipelineStage)
      }
      // Keep allow_auto_submit in sync with the batch that (re-)enqueued the
      // task: an idempotent re-POST that resumes a task must refresh the flag
      // so the stored column keeps reflecting the runtime option.
      if (allowAutoSubmit !== undefined && Boolean(existing.allow_auto_submit) !== Boolean(allowAutoSubmit)) {
        patch.push('allow_auto_submit = ?'); params.push(allowAutoSubmit ? 1 : 0)
      }
      if (patch.length > 0) {
        params.push(existing.id)
        const safeNowSql = nowSqlLiteral(db)
        await db.prepare(`UPDATE application_tasks SET ${patch.join(', ')}, updated_at = ${safeNowSql} WHERE id = ?`).run(...params)
        const refreshed = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(existing.id)
        return rowToTask(refreshed)
      }
      return rowToTask(existing)
    }

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO application_tasks
           (id, user_id, profile_id, opportunity_id, grant_id, portal_id, application_id,
            university_application_id, automation_type, selected_from_stage, current_pipeline_stage,
            agent_persona_version, assigned_agent, status, current_step, allow_auto_submit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hamilton', ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
      )
      .run(
        id,
        userId,
        String(profileId),
        opportunityId,
        grantId,
        portalId,
        applicationId,
        universityApplicationId,
        automationType,
        selectedFromStage,
        currentPipelineStage,
        agentPersonaVersion,
        initialStatus,
        currentStep,
        allowAutoSubmit === undefined ? 0 : (allowAutoSubmit ? 1 : 0),
      )

    await appendTaskEvent(db, {
      taskId: id,
      eventType: 'created',
      status: initialStatus,
      step: currentStep,
      message: `Application task created (automation_type=${automationType}, selected_from_stage=${selectedFromStage || 'unspecified'})`,
      actorUserId: userId,
      details: { automation_type: automationType, selected_from_stage: selectedFromStage, current_pipeline_stage: currentPipelineStage },
    })

    const row = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id)
    return rowToTask(row)
  })
}

export async function getApplicationTask(db, taskId, { profileId = null } = {}) {
  if (!taskId) return null
  await ensureApplicationTaskSchema(db)
  let row
  if (profileId) {
    row = await db
      .prepare('SELECT * FROM application_tasks WHERE id = ? AND profile_id = ?')
      .get(String(taskId), String(profileId))
  } else {
    row = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(String(taskId))
  }
  return row ? rowToTask(row) : null
}

export async function listApplicationTasks(db, { profileId, status = null, limit = 100 } = {}) {
  await ensureApplicationTaskSchema(db)
  const params = []
  let sql = 'SELECT * FROM application_tasks WHERE 1=1 '
  if (profileId) {
    sql += ' AND profile_id = ?'
    params.push(String(profileId))
  }
  if (status) {
    sql += ' AND status = ?'
    params.push(String(status))
  }
  sql += ' ORDER BY updated_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const rows = await db.prepare(sql).all(...params)
  return (rows || []).map(rowToTask)
}

/**
 * Patch a task. Only whitelisted columns are written.
 */
export async function updateApplicationTask(db, taskId, {
  status,
  currentStep,
  missingFields,
  missingDocuments,
  requiredUserActions,
  lastAgentMessage,
  autoSubmitEnabled,
  allowAutoSubmit,
  applicationId,
  universityApplicationId,
  portalId,
  automationType,
  selectedFromStage,
  currentPipelineStage,
  portalUrl,
  applicationUrl,
  outputDocumentId,
  outputPdfDocumentId,
  outputDocxDocumentId,
  outputProposalDocumentId,
  mailingInstructions,
  auditSummary,
  startedAt,
  submittedAt,
  completedAt,
  cancelledAt,
  nextRetryAt,
  retryCount,
} = {}) {
  if (!taskId) throw new Error('taskId required')
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`)
  }
  if (automationType !== undefined && !AUTOMATION_TYPES.includes(automationType)) {
    throw new Error(`invalid automationType: ${automationType}`)
  }
  await ensureApplicationTaskSchema(db)

  const sets = [`updated_at = ${nowSqlLiteral(db)}`]
  const params = []
  if (status !== undefined) { sets.push('status = ?'); params.push(status) }
  if (currentStep !== undefined) { sets.push('current_step = ?'); params.push(currentStep ?? null) }
  if (missingFields !== undefined) { sets.push('missing_fields_json = ?'); params.push(JSON.stringify(missingFields ?? [])) }
  if (missingDocuments !== undefined) { sets.push('missing_documents_json = ?'); params.push(JSON.stringify(missingDocuments ?? [])) }
  if (requiredUserActions !== undefined) { sets.push('required_user_actions_json = ?'); params.push(JSON.stringify(requiredUserActions ?? [])) }
  if (lastAgentMessage !== undefined) { sets.push('last_agent_message = ?'); params.push(lastAgentMessage ?? null) }
  if (autoSubmitEnabled !== undefined) { sets.push('auto_submit_enabled = ?'); params.push(autoSubmitEnabled ? 1 : 0) }
  if (allowAutoSubmit !== undefined) { sets.push('allow_auto_submit = ?'); params.push(allowAutoSubmit ? 1 : 0) }
  if (applicationId !== undefined) { sets.push('application_id = ?'); params.push(applicationId ?? null) }
  if (universityApplicationId !== undefined) { sets.push('university_application_id = ?'); params.push(universityApplicationId ?? null) }
  if (portalId !== undefined) { sets.push('portal_id = ?'); params.push(portalId ?? null) }
  if (automationType !== undefined) { sets.push('automation_type = ?'); params.push(automationType) }
  if (selectedFromStage !== undefined) { sets.push('selected_from_stage = ?'); params.push(selectedFromStage ?? null) }
  if (currentPipelineStage !== undefined) { sets.push('current_pipeline_stage = ?'); params.push(currentPipelineStage ?? null) }
  if (portalUrl !== undefined) { sets.push('portal_url = ?'); params.push(portalUrl ?? null) }
  if (applicationUrl !== undefined) { sets.push('application_url = ?'); params.push(applicationUrl ?? null) }
  if (outputDocumentId !== undefined) { sets.push('output_document_id = ?'); params.push(outputDocumentId ?? null) }
  if (outputPdfDocumentId !== undefined) { sets.push('output_pdf_document_id = ?'); params.push(outputPdfDocumentId ?? null) }
  if (outputDocxDocumentId !== undefined) { sets.push('output_docx_document_id = ?'); params.push(outputDocxDocumentId ?? null) }
  if (outputProposalDocumentId !== undefined) { sets.push('output_proposal_document_id = ?'); params.push(outputProposalDocumentId ?? null) }
  if (mailingInstructions !== undefined) { sets.push('mailing_instructions_json = ?'); params.push(JSON.stringify(mailingInstructions ?? {})) }
  if (auditSummary !== undefined) { sets.push('audit_summary_json = ?'); params.push(JSON.stringify(auditSummary ?? {})) }
  if (startedAt !== undefined) { sets.push('started_at = ?'); params.push(startedAt ?? null) }
  if (submittedAt !== undefined) { sets.push('submitted_at = ?'); params.push(submittedAt ?? null) }
  if (completedAt !== undefined) { sets.push('completed_at = ?'); params.push(completedAt ?? null) }
  if (cancelledAt !== undefined) { sets.push('cancelled_at = ?'); params.push(cancelledAt ?? null) }
  if (nextRetryAt !== undefined) { sets.push('next_retry_at = ?'); params.push(nextRetryAt ?? null) }
  if (retryCount !== undefined) { sets.push('retry_count = ?'); params.push(Number.isFinite(Number(retryCount)) ? Number(retryCount) : 0) }

  if (sets.length === 1) return await getApplicationTask(db, taskId)

  params.push(String(taskId))
  await db.prepare(`UPDATE application_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return await getApplicationTask(db, taskId)
}

// Statuses a task can be auto-resumed FROM once the user supplies the info
// Hamilton flagged: only genuine "waiting on the user for input" states — never
// terminal (submitted/completed/cancelled/failed) or in-flight ones.
export const RESUMABLE_AFTER_INFO_STATUSES = Object.freeze([
  'blocked', 'waiting_for_missing_info', 'waiting_for_user', 'waiting_for_admin',
])

/**
 * "Automation is king": once every flagged item is supplied, put a task that
 * was waiting on the user back into the run queue (status 'ready') so the
 * periodic Hamilton runner re-picks it and continues to completion/submission
 * — the user shouldn't have to manually relaunch after answering. Mirrors the
 * login backup plan's auto-resume.
 *
 * Only resumes when (a) at least one item was just resolved, (b) nothing
 * remains outstanding, and (c) the task is in a resumable waiting state.
 *
 * @returns {Promise<{resumed:boolean, status?:string}>}
 */
export async function resumeTaskAfterMissingInfo(db, taskId, { resolvedCount = 0, remainingCount = 0 } = {}) {
  if (!taskId) return { resumed: false }
  if (!(Number(resolvedCount) > 0 && Number(remainingCount) === 0)) return { resumed: false }
  const task = await getApplicationTask(db, taskId)
  if (!task) return { resumed: false }
  if (!RESUMABLE_AFTER_INFO_STATUSES.includes(task.status)) return { resumed: false, status: task.status }
  await updateApplicationTask(db, taskId, {
    status: 'ready',
    nextRetryAt: null,
    currentStep: 'resuming_after_missing_info',
    lastAgentMessage: 'All flagged information supplied — Hamilton will resume automatically and continue to completion.',
  })
  return { resumed: true, status: 'ready' }
}

// Words too generic to match a document requirement on (every doc is a
// "document"/"letter"/"form"); matching on these would resolve the wrong item.
const DOC_MATCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'your', 'our', 'most', 'recent', 'latest', 'current', 'copy',
  'document', 'documents', 'doc', 'docs', 'file', 'form', 'letter', 'statement',
  'report', 'records', 'record', 'proof', 'official', 'signed', 'scan', 'scanned',
  'pdf', 'jpg', 'jpeg', 'png', 'page', 'pages',
])

function docMatchTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !DOC_MATCH_STOPWORDS.has(t))
}

/**
 * Does an uploaded document's name plausibly satisfy a flagged document
 * requirement? Conservative token overlap on significant words: e.g. uploaded
 * "irs determination.pdf" matches required "IRS 501(c)(3) determination letter"
 * (shares irs+determination), but "board roster.pdf" does not match
 * "tax return". Requiring a shared significant token avoids resolving the wrong
 * requirement off generic words like "letter"/"form".
 */
export function documentNameMatchesRequirement(uploadedName, requirementLabel) {
  const a = new Set(docMatchTokens(uploadedName))
  const b = docMatchTokens(requirementLabel)
  if (a.size === 0 || b.length === 0) return false
  return b.some((t) => a.has(t))
}

/**
 * "Automation is king" for documents: when a document is uploaded to a profile,
 * resolve any flagged document requirement it satisfies across that profile's
 * waiting tasks and auto-resume the ones with nothing left outstanding — so the
 * user uploading a doc continues Hamilton on its own, exactly like supplying a
 * missing field. Best-effort and side-effect-light; safe to call on every
 * upload.
 *
 * @returns {Promise<{tasksResumed:number, itemsResolved:number, resumedTaskIds:string[]}>}
 */
export async function reconcileProfileDocumentUploads(db, { profileId, documentName, resolvedBy = 'document_upload' } = {}) {
  const out = { tasksResumed: 0, itemsResolved: 0, resumedTaskIds: [] }
  if (!db || !profileId || !documentName) return out
  await ensureApplicationTaskSchema(db)
  const placeholders = RESUMABLE_AFTER_INFO_STATUSES.map(() => '?').join(',')
  let tasks = []
  try {
    tasks = await db.prepare(
      `SELECT id FROM application_tasks WHERE profile_id = ? AND status IN (${placeholders})`,
    ).all(String(profileId), ...RESUMABLE_AFTER_INFO_STATUSES)
    if (!Array.isArray(tasks)) tasks = []
  } catch { return out }

  for (const t of tasks) {
    const docItems = (await listMissingInfo(db, t.id, { includeResolved: false }))
      .filter((m) => m.kind === 'document')
    let resolvedHere = 0
    for (const item of docItems) {
      if (documentNameMatchesRequirement(documentName, item.label || item.key)) {
        const ok = await resolveMissingInfoItem(db, t.id, {
          kind: 'document', key: item.key, value: documentName, resolvedBy,
        })
        if (ok) { resolvedHere += 1; out.itemsResolved += 1 }
      }
    }
    if (resolvedHere === 0) continue
    const remaining = await listMissingInfo(db, t.id, { includeResolved: false })
    const resume = await resumeTaskAfterMissingInfo(db, t.id, { resolvedCount: resolvedHere, remainingCount: remaining.length })
    if (resume.resumed) {
      out.resumedTaskIds.push(t.id)
      out.tasksResumed += 1
      await appendTaskEvent(db, {
        taskId: t.id,
        eventType: 'unblocked',
        status: 'ready',
        step: 'auto_resume',
        message: `Document "${documentName}" satisfied a flagged requirement — task re-queued; Hamilton will resume automatically.`,
        actorRole: 'agent',
        details: { auto_resumed: true, via: 'document_upload', document_name: documentName },
      })
    }
  }
  return out
}

// Flatten profile_sections rows into a lookup of candidate field keys → value,
// indexing both the leaf key ("ein") and the dotted path ("organization_details.ein")
// so a flagged field's key matches however it was named. Empty values are skipped.
function flattenProfileSectionValues(sectionRows) {
  const map = {}
  for (const row of (sectionRows || [])) {
    let data = row?.data
    if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = null } }
    const sectionKey = String(row?.section_key || '').toLowerCase()
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v); continue }
        const val = Array.isArray(v) ? v.filter(Boolean).join(', ') : v
        if (val === null || val === undefined || String(val).trim() === '') continue
        const leaf = String(k).toLowerCase()
        if (!map[leaf]) map[leaf] = String(val)
        if (sectionKey) map[`${sectionKey}.${leaf}`] = String(val)
      }
    }
    walk(data)
  }
  return map
}

// Statuses whose missing-info rows are DEAD — the task's run is over, so a
// stale "missing first name" row on it can't spam the needs list (the summary
// treats these as terminal too) and re-writing history on them adds nothing.
const FIELD_RECONCILE_SKIP_STATUSES = Object.freeze([
  ...TASK_TERMINAL_STATUSES, 'completed',
])

/**
 * THE "add it once, it clears everywhere" rule for profile fields.
 *
 * Whenever the profile gains information — a section edit, an interview
 * answer, a parsed document, a boot sweep — every task-flagged FIELD the
 * profile can now answer is resolved across ALL of that profile's live tasks,
 * and any resumable task with nothing left outstanding is re-queued. Without
 * this, 30+ portal tasks each kept their own stale "Profile is missing first
 * name" row after the name was added (the Anastasia class, owner report
 * 2026-07-27): the flags were per-task, the fix was profile-wide, and nothing
 * connected the two outside the document-parse path.
 *
 * Values come from profile_sections (leaf + dotted keys), the profiles row's
 * own scalar columns, and — because portals ask for name PARTS while many
 * profiles carry one display_name — first/middle/last derived via the
 * canonical parseFullName (persons only; an org-looking name derives nothing).
 * Best-effort throughout; safe to call on every profile write.
 *
 * @returns {Promise<{tasksResumed:number, fieldsResolved:number, resumedTaskIds:string[]}>}
 */
export async function reconcileProfileFieldsToTasks(db, {
  profileId,
  resolvedBy = 'profile_update',
  resumeMessage = 'The profile now has everything this task was waiting on — task re-queued; Hamilton will resume automatically.',
} = {}) {
  const out = { tasksResumed: 0, fieldsResolved: 0, resumedTaskIds: [] }
  if (!db || !profileId) return out
  await ensureApplicationTaskSchema(db)

  let sections = []
  try {
    sections = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(String(profileId))
  } catch { sections = [] }
  const values = flattenProfileSectionValues(sections)

  // The profiles row itself (display_name and friends) — sections don't hold
  // everything, and older profiles carry the name ONLY here.
  try {
    const prow = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(String(profileId))
    for (const [k, v] of Object.entries(prow || {})) {
      if (v === null || v === undefined || typeof v === 'object') continue
      const s = String(v).trim()
      if (!s) continue
      const leaf = String(k).toLowerCase()
      if (!values[leaf]) values[leaf] = s
    }
  } catch { /* profiles table shape varies on minimal DBs */ }

  // Portals flag name PARTS; profiles often carry one full/display name.
  const fullName = values.full_name || values.display_name || values.name || ''
  if (fullName && (!values.first_name || !values.last_name)) {
    const parts = parseFullName(fullName)
    if (!parts.is_org) {
      if (parts.first_name && !values.first_name) values.first_name = parts.first_name
      if (parts.middle_name && !values.middle_name) values.middle_name = parts.middle_name
      if (parts.last_name && !values.last_name) values.last_name = parts.last_name
    }
  }

  // FAFSA-linked portals file ONE structured ask (kind 'field', key
  // 'fafsa_link' — "this portal awards straight from your FAFSA"). It is
  // answerable ONLY by a real profile signal: the education section's
  // canonical FAFSA lifecycle says the FAFSA is FILED (fafsa_status at/after
  // 'submitted', or the legacy fafsa_completed boolean). A not-yet-filed FAFSA
  // keeps the honest ask, and nothing here ever fabricates an FSA ID or claims
  // a portal-side linkage happened. The generic flatten above must never
  // decide this key (a stray profile field named fafsa_link, or a
  // fafsa_completed=false stringified to 'false', would otherwise "answer"
  // it), so the honest gate below is the single authority.
  delete values.fafsa_link
  delete values['education.fafsa_link']
  const eduRow = (sections || []).find((r) => String(r?.section_key || '').toLowerCase() === 'education')
  if (eduRow) {
    let edu = eduRow.data
    if (typeof edu === 'string') { try { edu = JSON.parse(edu) } catch { edu = null } }
    if (edu && typeof edu === 'object') {
      const status = normalizeFafsaStatus(edu)
      const filed = (edu.fafsa_status && deriveFafsaCompleted(status.stage))
        || edu.fafsa_completed === true
        || String(edu.fafsa_completed).trim().toLowerCase() === 'true'
      if (filed) values.fafsa_link = `fafsa_${status.stage}`
    }
  }

  if (Object.keys(values).length === 0) return out

  const skip = FIELD_RECONCILE_SKIP_STATUSES.map(() => '?').join(',')
  let tasks = []
  try {
    tasks = await db.prepare(
      `SELECT id FROM application_tasks WHERE profile_id = ? AND status NOT IN (${skip})`,
    ).all(String(profileId), ...FIELD_RECONCILE_SKIP_STATUSES)
    if (!Array.isArray(tasks)) tasks = []
  } catch { return out }

  for (const t of tasks) {
    const fieldItems = (await listMissingInfo(db, t.id, { includeResolved: false }))
      .filter((m) => m.kind === 'field')
    let resolvedHere = 0
    for (const item of fieldItems) {
      const key = String(item.key || '').toLowerCase()
      const leaf = key.split('.').pop()
      const value = (values[key] && values[key].trim()) ? values[key] : (leaf && values[leaf] && values[leaf].trim() ? values[leaf] : null)
      if (value) {
        const ok = await resolveMissingInfoItem(db, t.id, { kind: 'field', key: item.key, value, resolvedBy })
        if (ok) { resolvedHere += 1; out.fieldsResolved += 1 }
      }
    }
    if (resolvedHere === 0) continue
    const remaining = await listMissingInfo(db, t.id, { includeResolved: false })
    const resume = await resumeTaskAfterMissingInfo(db, t.id, { resolvedCount: resolvedHere, remainingCount: remaining.length })
    if (resume.resumed) {
      out.resumedTaskIds.push(t.id)
      out.tasksResumed += 1
      await appendTaskEvent(db, {
        taskId: t.id,
        eventType: 'unblocked',
        status: 'ready',
        step: 'auto_resume',
        message: resumeMessage,
        actorRole: 'agent',
        details: { auto_resumed: true, via: resolvedBy, fields_resolved: resolvedHere },
      })
    }
  }
  return out
}

/**
 * After a document is parsed into a profile (profile_sections updated), re-check
 * that profile's waiting tasks: any field Hamilton flagged that the parsed
 * document just populated is resolved, and a task with nothing left outstanding
 * is re-queued — so "parse the doc → Hamilton knows what to place where →
 * Hamilton continues" happens automatically. Thin wrapper over the canonical
 * reconcileProfileFieldsToTasks (one resolution rule, no drift).
 *
 * @returns {Promise<{tasksResumed:number, fieldsResolved:number, resumedTaskIds:string[]}>}
 */
export async function reconcileProfileAfterParse(db, { profileId } = {}) {
  return reconcileProfileFieldsToTasks(db, {
    profileId,
    resolvedBy: 'document_parse',
    resumeMessage: 'Hamilton parsed your uploaded document and filled the flagged detail(s) — task re-queued; she will resume automatically.',
  })
}

export async function cancelApplicationTask(db, taskId, { actorUserId = null, actorRole = null, reason = null } = {}) {
  await ensureApplicationTaskSchema(db)
  const ts = new Date().toISOString()
  await db
    .prepare(
      `UPDATE application_tasks
         SET status = 'cancelled', cancelled_at = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE id = ?`,
    )
    .run(ts, String(taskId))
  await appendTaskEvent(db, {
    taskId,
    eventType: 'cancelled',
    status: 'cancelled',
    message: reason || 'task cancelled',
    actorUserId,
    actorRole,
  })
  return await getApplicationTask(db, taskId)
}

// ── Events ─────────────────────────────────────────────────────────

export async function appendTaskEvent(db, {
  taskId,
  eventType,
  status = null,
  step = null,
  message = null,
  details = null,
  actorUserId = null,
  actorRole = null,
} = {}) {
  if (!taskId) throw new Error('taskId required')
  if (!eventType) throw new Error('eventType required')
  await ensureApplicationTaskSchema(db)
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO application_task_events
         (id, task_id, event_type, status, step, message, details_json, actor_user_id, actor_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)})`,
    )
    .run(
      id,
      String(taskId),
      String(eventType),
      status ?? null,
      step ?? null,
      message ?? null,
      JSON.stringify(details ?? {}),
      actorUserId ?? null,
      actorRole ?? null,
    )
  return id
}

export async function listTaskEvents(db, taskId, { limit = 200 } = {}) {
  if (!taskId) return []
  await ensureApplicationTaskSchema(db)
  const rows = await db
    .prepare(
      `SELECT * FROM application_task_events
        WHERE task_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(String(taskId), Math.max(1, Math.min(1000, Number(limit) || 200)))
  return (rows || []).map(rowToEvent)
}

// ── Missing info ───────────────────────────────────────────────────

export async function setMissingInfo(db, taskId, items = []) {
  await ensureApplicationTaskSchema(db)
  if (!Array.isArray(items)) items = []
  for (const item of items) {
    if (!item || !item.kind || !item.key) continue
    if (!MISSING_INFO_KINDS.includes(item.kind)) continue
    const existing = await db
      .prepare(`SELECT id FROM application_missing_info WHERE task_id = ? AND kind = ? AND key = ? LIMIT 1`)
      .get(String(taskId), item.kind, String(item.key))
    if (existing) {
      await db
        .prepare(
          `UPDATE application_missing_info
             SET label = COALESCE(?, label),
                 description = COALESCE(?, description),
                 required = COALESCE(?, required),
                 updated_at = ${nowSqlLiteral(db)}
           WHERE id = ?`,
        )
        .run(item.label ?? null, item.description ?? null, item.required === undefined ? null : (item.required ? 1 : 0), existing.id)
    } else {
      await db
        .prepare(
          `INSERT INTO application_missing_info
             (id, task_id, kind, key, label, description, required, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
        )
        .run(
          crypto.randomUUID(),
          String(taskId),
          item.kind,
          String(item.key),
          item.label ?? null,
          item.description ?? null,
          item.required === false ? 0 : 1,
        )
    }
  }
}

export async function listMissingInfo(db, taskId, { includeResolved = true } = {}) {
  if (!taskId) return []
  await ensureApplicationTaskSchema(db)
  const sql = includeResolved
    ? 'SELECT * FROM application_missing_info WHERE task_id = ? ORDER BY created_at ASC'
    : 'SELECT * FROM application_missing_info WHERE task_id = ? AND resolved = 0 ORDER BY created_at ASC'
  const rows = await db.prepare(sql).all(String(taskId))
  return (rows || []).map(rowToMissing)
}

/**
 * Batched variant of listMissingInfo: ONE query for many tasks instead of one
 * query per task. The profile-summary endpoint reads up to 200 tasks; serial
 * per-task reads under a contended pool were slow enough to trip proxy
 * timeouts. Returns a Map of taskId -> missing-info items (same item shape as
 * listMissingInfo); tasks with no rows are simply absent from the map.
 */
export async function listMissingInfoForTasks(db, taskIds, { includeResolved = true } = {}) {
  const ids = [...new Set((taskIds || []).filter(Boolean).map(String))]
  const byTask = new Map()
  if (ids.length === 0) return byTask
  await ensureApplicationTaskSchema(db)
  const ph = ids.map(() => '?').join(',')
  const sql = includeResolved
    ? `SELECT * FROM application_missing_info WHERE task_id IN (${ph}) ORDER BY created_at ASC`
    : `SELECT * FROM application_missing_info WHERE task_id IN (${ph}) AND resolved = 0 ORDER BY created_at ASC`
  const rows = await db.prepare(sql).all(...ids)
  for (const row of rows || []) {
    const key = String(row.task_id)
    if (!byTask.has(key)) byTask.set(key, [])
    byTask.get(key).push(rowToMissing(row))
  }
  return byTask
}

export async function resolveMissingInfoItem(db, taskId, { kind, key, value, resolvedBy = null } = {}) {
  if (!taskId || !kind || !key) throw new Error('taskId/kind/key required')
  await ensureApplicationTaskSchema(db)
  const ts = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE application_missing_info
         SET resolved = 1, resolved_at = ?, resolved_by = ?,
             resolved_value_json = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE task_id = ? AND kind = ? AND key = ?`,
    )
    .run(
      ts,
      resolvedBy ?? null,
      JSON.stringify(value ?? null),
      String(taskId),
      String(kind),
      String(key),
    )
  return Number(result?.changes ?? result?.rowCount ?? 0) > 0
}

export { rowToTask as _rowToTask, rowToEvent as _rowToEvent, rowToMissing as _rowToMissing }
