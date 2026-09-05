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
import { assessTaskSubmissionProof, SUBMISSION_PROOF_STATE } from './submissionProofPredicate.js'
import { assessPointerResearchLead } from './hamiltonFundingSourcePolicy.js'
import {
  TASK_STATUS_BUCKET,
  TASK_STATUS_ALIASES,
  bucketForTaskStatus,
  isRecognisedTaskStatus,
} from '../../../shared/hamiltonTaskLifecycle.js'
import {
  assessDuplicateApplicationRisk,
  DuplicateApplicationRiskError,
} from './priorCycleApplicationGuard.js'

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
  // Durable irreversible-boundary states. `submit_attempt_started` is acquired
  // with a compare-and-swap immediately before the external submit action;
  // `submit_evidence_pending` means the action may have happened but proof is
  // not durable yet. Neither state may be blindly retried after a restart.
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
  'saving_portal_draft',
  'waiting_for_review',
  'ready_to_submit',
  'ready_to_print_mail',
  'ready_to_email',
  'ready_to_fax',
  'completed',
  'blocked',
])

export const SUBMISSION_ATTEMPT_STATUSES = Object.freeze([
  'submit_attempt_started',
  'submit_evidence_pending',
])

// Cancellation is no longer an honest terminal claim once the irreversible
// boundary may have been crossed. Keep an already-quarantined task in the same
// state if cancellation is requested again.
export const SUBMISSION_UNCERTAIN_STATUSES = Object.freeze([
  ...SUBMISSION_ATTEMPT_STATUSES,
  'submission_verification_required',
])

export const AUTOMATION_TYPES = Object.freeze([
  'portal',
  'pdf_docx',
  'mail',
  'fax',
  'email',
  'no_application',
  'auto_profile',
  // A pointer-kind source is not an application at all, even with a usable
  // discovery URL. It remains a labeled research lead; decomposition creates
  // only independently verified leaf tasks (owner directive 2026-09-02).
  'research_lead',
  'unknown',
])

export const TASK_BLOCKED_STATUSES = Object.freeze([
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
])

/** Closed states a deliberate re-run may re-open when no submission proof exists. */
export const REOPENABLE_CLOSED_STATUSES = Object.freeze(['completed', 'failed'])

export const TASK_TERMINAL_STATUSES = Object.freeze([
  'submitted',
  'failed',
  'cancelled',
])

// SQL has to partition the queue before applying its limit. Derive the
// finished vocabulary from the same lifecycle map used by every UI surface so
// an older unfinished row can never disappear behind newer history.
const FINISHED_TASK_STATUS_VALUES = Object.freeze([
  ...Object.entries(TASK_STATUS_BUCKET)
    .filter(([, bucket]) => bucket === 'finished')
    .map(([status]) => status),
  ...Object.entries(TASK_STATUS_ALIASES)
    .filter(([, canonical]) => TASK_STATUS_BUCKET[canonical] === 'finished')
    .map(([alias]) => alias),
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
    // These statements must share one PostgreSQL transaction. If an unknown
    // persisted status makes the ADD fail, PostgreSQL rolls the DROP back too;
    // the service must never commit a half-applied self-heal with no CHECK at
    // all. The table lock also serializes concurrent boot attempts.
    if (typeof db.withTransaction !== 'function') {
      throw new Error('application_tasks status CHECK resync requires transactional DDL')
    }
    await db.withTransaction(async (tx) => {
      await tx.exec(
        'ALTER TABLE application_tasks DROP CONSTRAINT IF EXISTS application_tasks_status_check',
      )
      await tx.exec(
        `ALTER TABLE application_tasks ADD CONSTRAINT application_tasks_status_check CHECK (status IN (${statusList}))`,
      )
    })
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

function isMissingTaskSourceTable(error) {
  const message = String(error?.message || error).toLowerCase()
  return (
    /no such table/.test(message)
    || /relation .* does not exist/.test(message)
    || /undefined table/.test(message)
    || String(error?.code || '') === '42P01'
  )
}

async function loadOptionalTaskSourceRow(db, table, id) {
  if (!id) return null
  try {
    if (table === 'grants') {
      return await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(id))
    }
    return await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(id))
  } catch (error) {
    // Minimal/local schemas legitimately omit one or both source tables. A
    // missing table means there is no catalog-kind evidence to adjudicate;
    // other DB failures remain loud so a transient outage cannot mint a task
    // while its source policy is unknowable.
    if (isMissingTaskSourceTable(error)) return null
    throw error
  }
}

function normalizeTaskIdentity(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function firstUsableTaskUrl(values) {
  for (const value of values) {
    const url = String(value ?? '').trim()
    if (/^https?:\/\//i.test(url)) return url
  }
  return null
}

export class ApplicationTaskSourceScopeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApplicationTaskSourceScopeError'
    this.code = 'application_task_source_scope_mismatch'
    this.status = 403
    this.statusCode = 403
  }
}

export class PointerResearchLeadTaskError extends Error {
  constructor(lead) {
    super(lead?.instructions || 'This pointer is a research lead, not an application surface.')
    this.name = 'PointerResearchLeadTaskError'
    this.code = 'pointer_research_lead'
    this.status = 422
    this.statusCode = 422
    this.handoff = lead ?? null
  }
}

export class ActiveManualSubmissionReceiptError extends Error {
  constructor() {
    super('This task has active manual-submission proof. Revoke that receipt before changing its submission identity.')
    this.name = 'ActiveManualSubmissionReceiptError'
    this.code = 'manual_submission_receipt_active'
    this.status = 409
    this.statusCode = 409
  }
}

function isMissingManualReceiptTable(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    String(error?.code || '') === '42P01'
    || message.includes('no such table: hamilton_manual_submission_receipts')
    || message.includes('relation "hamilton_manual_submission_receipts" does not exist')
  )
}

function isManualReceiptIdentityTriggerError(error) {
  return String(error?.message || error || '')
    .toLowerCase()
    .includes('active manual submission receipt locks task identity')
}

async function lockTaskAndAssertNoActiveManualReceipt(db, taskId) {
  const lockClause = db?.dialect === 'postgres' ? ' FOR UPDATE' : ''
  const task = await db.prepare(
    `SELECT id FROM application_tasks WHERE id = ? LIMIT 1${lockClause}`,
  ).get(String(taskId))
  if (!task) return null

  let activeReceipt = null
  try {
    activeReceipt = await db.prepare(
      `SELECT id FROM hamilton_manual_submission_receipts
        WHERE task_id = ? AND status = 'active' LIMIT 1`,
    ).get(String(taskId))
  } catch (error) {
    // Rolling deploys may run old schemas before receipt uploads are available.
    // Only the exact absent-table state is ignorable.
    if (!isMissingManualReceiptTable(error)) throw error
  }
  if (activeReceipt) throw new ActiveManualSubmissionReceiptError()
  return task
}

/**
 * Resolve the catalog row that actually governs a task and apply the shared
 * pointer policy before any application_tasks write. Grant linkage wins over
 * a caller-supplied opportunity id because a grant-backed task's identity is
 * the existing pipeline row. Direct/kindless/manual subjects remain untouched.
 */
export async function assessApplicationTaskPointerSource(db, {
  profileId,
  opportunityId = null,
  grantId = null,
  applicationUrl = null,
  portalUrl = null,
} = {}) {
  const normalizedProfileId = normalizeTaskIdentity(profileId)
  const grant = await loadOptionalTaskSourceRow(db, 'grants', grantId)
  if (
    grant?.profile_id
    && normalizedProfileId
    && String(grant.profile_id) !== normalizedProfileId
  ) {
    throw new ApplicationTaskSourceScopeError('The grant does not belong to the selected profile.')
  }

  const catalogIds = Array.from(new Set([
    normalizeTaskIdentity(grant?.funding_opportunity_id ?? grant?.opportunity_id),
    normalizeTaskIdentity(opportunityId),
  ].filter(Boolean)))
  let opportunity = null
  for (const catalogId of catalogIds) {
    opportunity = await loadOptionalTaskSourceRow(db, 'funding_opportunities', catalogId)
    if (opportunity) break
  }
  if (!opportunity) return null
  // `funding_opportunities.profile_id` is DISCOVERY PROVENANCE (the profile the
  // catalog row was first found for), NOT exclusive ownership: a national/local/
  // shared source discovered for one profile is legitimately applicable to
  // another, and the recall nets (profile-discovery-link etc.) re-offer such rows
  // across profiles. The GRANT is the ownership authority (checked above). So a
  // same-profile grant backing this task authorizes the claim regardless of the
  // opportunity's provenance tag — refusing there is the cross-profile false-403
  // that blocked a real Bradley County source (Family Promise) for a second
  // Bradley County family. Only a BARE opportunity task (no grant) still checks
  // provenance, and even then only when the row is not shareable (national).
  const shareableOpportunity = opportunity.is_national === true
    || opportunity.is_national === 1
    || opportunity.is_national === '1'
  if (
    !grant
    && !shareableOpportunity
    && opportunity.profile_id
    && normalizedProfileId
    && String(opportunity.profile_id) !== normalizedProfileId
  ) {
    throw new ApplicationTaskSourceScopeError('The funding opportunity does not belong to the selected profile.')
  }

  const usableUrl = firstUsableTaskUrl([
    opportunity.application_url,
    opportunity.apply_url,
    opportunity.source_url,
    opportunity.url,
    opportunity.evidence_url,
    grant?.application_url,
    grant?.apply_url,
    grant?.source_url,
    grant?.url,
    grant?.evidence_url,
    applicationUrl,
    portalUrl,
  ])
  return assessPointerResearchLead({
    ...opportunity,
    title: opportunity.title ?? grant?.title ?? null,
    // Give the policy the combined, evidence-backed task surface without
    // mutating either source row. The URL is useful in the research handoff,
    // but never turns a listing surface into an application.
    url: usableUrl ?? opportunity.url ?? null,
  })
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
  // Per-task acknowledgement that this really is a SEPARATE funder cycle, set
  // only by an explicit human action on the duplicate-risk handoff. Deliberately
  // NOT accepted from batch automation: a batch must never blanket-confirm past
  // this guard for every task at once, which would turn a safety net into a
  // rubber stamp. See routes/hamilton.js for the single call site that sets it.
  confirmedNewCycle = false,
  // RE-OPEN A TASK CLOSED WITHOUT PROOF (owner order 2026-09-05). A task that
  // ended `completed` as a research lead ("found no application form", a
  // listing decomposition) or `failed` is not a finished APPLICATION — no
  // portal confirmation exists. Yet the status was terminal for every re-run:
  // updateApplicationTask's unlessCancelled guard refused the launch
  // transition and the run ended "task moved to protected state completed"
  // (prod 2026-09-05: five of six re-selected MTSU/TSAC rows). When a person
  // deliberately re-selects or retries such a task, re-open it at the
  // pathway's initial status; a task with VERIFIED external submission proof
  // is never re-opened, and `submitted`/`cancelled` are untouched. Off for
  // autonomous scheduler runs so a nightly sweep cannot churn closed leads.
  reopenClosed = false,
} = {}) {
  if (!profileId) throw new Error('profileId required')
  if (!opportunityId && !grantId) throw new Error('opportunityId or grantId required')
  if (!TASK_STATUSES.includes(initialStatus)) {
    throw new Error(`invalid initialStatus: ${initialStatus}`)
  }
  if (!AUTOMATION_TYPES.includes(automationType)) {
    throw new Error(`invalid automationType: ${automationType}`)
  }

  const pointerLead = await assessApplicationTaskPointerSource(db, {
    profileId,
    opportunityId,
    grantId,
  })
  if (pointerLead) throw new PointerResearchLeadTaskError(pointerLead)

  await ensureApplicationTaskSchema(db)

  return await withProfileScope({ bypass: true }, async () => {
    let existing = await db
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
    // A GRANT-backed task's identity is (profile, grant) — the grant IS the
    // pipeline identity; opportunity_id only differentiates grantless
    // (portal/university) tasks. The exact-key lookup above treated
    // (grant, NULL-opp) and (grant, opp) as DIFFERENT tasks, so the 2026-07-21
    // batch minted duplicates for grants whose earlier task predated
    // opportunity linking (prod: one grant with a 'completed' 07-21 task AND a
    // 'ready_to_start' 07-01 task). When no exact-key row exists, ADOPT a
    // live same-grant task instead of duplicating it — and backfill its
    // opportunity_id when the found row has none. A TERMINAL same-grant task
    // is deliberately not adopted: cancel-then-recreate stays possible.
    if (!existing && grantId) {
      const grantMatch = await db
        .prepare(
          `SELECT * FROM application_tasks
            WHERE profile_id = ? AND grant_id = ?
              AND (status IS NULL OR status NOT IN (${TASK_TERMINAL_STATUSES.map(() => '?').join(', ')}))
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(String(profileId), String(grantId), ...TASK_TERMINAL_STATUSES)
      if (grantMatch) {
        if (opportunityId && !grantMatch.opportunity_id) {
          try {
            await db
              .prepare(`UPDATE application_tasks SET opportunity_id = ?, updated_at = ${nowSqlLiteral(db)} WHERE id = ?`)
              .run(String(opportunityId), grantMatch.id)
            grantMatch.opportunity_id = String(opportunityId)
          } catch {
            // A unique-key collision here means the exact-key row appeared
            // concurrently — fall through with the un-backfilled row, which
            // still prevents a duplicate create.
          }
        }
        existing = grantMatch
      }
    }
    if (existing) {
      let reopenedFrom = null
      if (reopenClosed && REOPENABLE_CLOSED_STATUSES.includes(existing.status)) {
        // The predicate scans evidence only for a submitted-shaped status; a
        // `completed` row that DOES carry a confirmation (run reference,
        // receipt, confirmation document) must still be recognized, so the
        // evidence scan runs as if the row were submitted. Evidence decides.
        // An UNREADABLE proof store is not "no proof": fail closed and leave
        // the task shut rather than re-open over evidence that could not be read.
        let proof = null
        try { proof = await assessTaskSubmissionProof(db, { ...rowToTask(existing), status: 'submitted' }) } catch { proof = null }
        if (proof && proof.verified_external !== true) reopenedFrom = existing.status
      }
      // Re-bump the automation metadata when the user re-selects the
      // same source from a different stage so the task picks up the
      // latest classification + selected-from-stage.
      const patch = []
      const params = []
      if (reopenedFrom) {
        patch.push('status = ?'); params.push(initialStatus)
        patch.push('next_retry_at = NULL')
        patch.push('completed_at = NULL')
        patch.push('last_agent_message = ?')
        params.push(`Re-opened for a new Hamilton run (the earlier close as "${reopenedFrom}" held no portal confirmation).`)
      }
      if (automationType && automationType !== 'unknown' && existing.automation_type !== automationType) {
        patch.push('automation_type = ?'); params.push(automationType)
      }
      if (selectedFromStage && existing.selected_from_stage !== selectedFromStage) {
        patch.push('selected_from_stage = ?'); params.push(selectedFromStage)
      }
      if (currentPipelineStage && existing.current_pipeline_stage !== currentPipelineStage) {
        patch.push('current_pipeline_stage = ?'); params.push(currentPipelineStage)
      }
      // Keep BOTH legacy intent columns in sync with the batch that
      // (re-)enqueued the task. The irreversible boundary reads the canonical
      // allow_auto_submit value, but leaving auto_submit_enabled stale lets a
      // legacy retry silently revive consent after the owner turns it off.
      // A new denial is always safe. A new grant is not: once a task is at an
      // irreversible/verification boundary or terminal state, a re-POSTed
      // batch must not revive submission intent behind that durable state.
      const submitIntentCanBeGranted = Boolean(reopenedFrom)
        || (!SUBMISSION_UNCERTAIN_STATUSES.includes(existing.status)
          && !TASK_TERMINAL_STATUSES.includes(existing.status)
          && existing.status !== 'completed')
      if (
        allowAutoSubmit !== undefined
        && (!allowAutoSubmit || submitIntentCanBeGranted)
        && (
          Boolean(existing.allow_auto_submit) !== Boolean(allowAutoSubmit)
          || Boolean(existing.auto_submit_enabled) !== Boolean(allowAutoSubmit)
        )
      ) {
        patch.push('allow_auto_submit = ?'); params.push(allowAutoSubmit ? 1 : 0)
        patch.push('auto_submit_enabled = ?'); params.push(allowAutoSubmit ? 1 : 0)
      }
      if (patch.length > 0) {
        params.push(existing.id)
        const safeNowSql = nowSqlLiteral(db)
        await db.prepare(`UPDATE application_tasks SET ${patch.join(', ')}, updated_at = ${safeNowSql} WHERE id = ?`).run(...params)
        if (reopenedFrom) {
          await appendTaskEvent(db, {
            taskId: existing.id,
            eventType: 'note',
            status: initialStatus,
            step: 'reopened',
            message: `Re-opened for a new Hamilton run: the earlier "${reopenedFrom}" close held no portal confirmation, so it was not a finished application.`,
            actorUserId: userId,
            actorRole: 'agent',
            details: { previous_status: reopenedFrom, reopened_to: initialStatus },
          }).catch(() => {})
        }
        const refreshed = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(existing.id)
        return rowToTask(refreshed)
      }
      return rowToTask(existing)
    }

    // CROSS-CYCLE DUPLICATE GUARD — deliberately placed HERE, on the create
    // path, and NOT beside the pointer-lead check above.
    //
    // ensureApplicationTask is idempotent: when a task already exists it is
    // ADOPTED and returned. A claim is minted from that same task's verified
    // submission, and it matches the same program identity — so guarding before
    // the existing-task lookup would 422 every later re-entry into a task the
    // profile had already legitimately submitted, breaking the tracker for
    // exactly the applications that worked. By this line we know no task exists
    // and we are about to INSERT a genuinely new one, which is the only moment
    // a duplicate submission can be created.
    if (!confirmedNewCycle) {
      const duplicateRisk = await assessDuplicateApplicationRisk(db, {
        profileId,
        opportunityId,
      })
      if (duplicateRisk) throw new DuplicateApplicationRiskError(duplicateRisk)
    }

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO application_tasks
           (id, user_id, profile_id, opportunity_id, grant_id, portal_id, application_id,
            university_application_id, automation_type, selected_from_stage, current_pipeline_stage,
            agent_persona_version, assigned_agent, status, current_step, auto_submit_enabled,
            allow_auto_submit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hamilton', ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
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

/**
 * Attach the canonical `submission_proof` label to a task so EVERY surface
 * (tracker/API/reporting) reads honestly. The single source of truth for
 * "externally submitted with proof" vs "marked submitted (internal record)" is
 * `assessTaskSubmissionProof` — a generated packet/draft/proposal
 * `output_document_id` NEVER reads as proof. Computed only for `submitted`
 * tasks (the only rows that assert a submission); other statuses get a cheap
 * NOT_SUBMITTED stub with no extra queries. Best-effort: a lookup failure
 * degrades to an honest "unknown" that still never over-claims proof.
 */
async function attachSubmissionProof(db, task) {
  if (!task) return task
  const status = String(task.status || '').trim().toLowerCase()
  if (status !== 'submitted') {
    task.submission_proof = {
      verified_external: false,
      state: SUBMISSION_PROOF_STATE.NOT_SUBMITTED,
    }
    return task
  }
  try {
    task.submission_proof = await assessTaskSubmissionProof(db, task)
  } catch {
    // Never over-claim on error: an internal-record label is the safe default.
    task.submission_proof = {
      verified_external: false,
      state: SUBMISSION_PROOF_STATE.INTERNAL_ONLY,
      label: 'Marked submitted (internal record — not confirmed sent to the funder)',
      source: 'none',
      proof_document_id: null,
      confirmation_reference: null,
      unverified_reason: 'assessment_error',
    }
  }
  return task
}

export async function getApplicationTask(db, taskId, { profileId = null, withSubmissionProof = true } = {}) {
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
  if (!row) return null
  const task = rowToTask(row)
  return withSubmissionProof ? attachSubmissionProof(db, task) : task
}

function appendApplicationTaskFilters(sql, params, {
  profileId,
  status = null,
  automationType = null,
  taskBucket = null,
} = {}) {
  if (profileId) {
    sql += ' AND profile_id = ?'
    params.push(String(profileId))
  }
  if (status) {
    sql += ' AND status = ?'
    params.push(String(status))
  }
  if (automationType) {
    sql += ' AND automation_type = ?'
    params.push(String(automationType))
  }
  if (taskBucket) {
    if (taskBucket !== 'current' && taskBucket !== 'finished') {
      throw new TypeError(`Unknown Hamilton task bucket: ${taskBucket}`)
    }
    const placeholders = FINISHED_TASK_STATUS_VALUES.map(() => '?').join(', ')
    sql += taskBucket === 'finished'
      ? ` AND LOWER(COALESCE(status, '')) IN (${placeholders})`
      : ` AND LOWER(COALESCE(status, '')) NOT IN (${placeholders})`
    params.push(...FINISHED_TASK_STATUS_VALUES)
  }
  return sql
}

export async function listApplicationTasks(db, {
  profileId,
  status = null,
  automationType = null,
  taskBucket = null,
  limit = 100,
  withSubmissionProof = true,
} = {}) {
  await ensureApplicationTaskSchema(db)
  const params = []
  let sql = appendApplicationTaskFilters('SELECT * FROM application_tasks WHERE 1=1', params, {
    profileId,
    status,
    automationType,
    taskBucket,
  })
  sql += ' ORDER BY updated_at DESC'
  // `null` is reserved for the authorised current-task endpoint, which must
  // return every unfinished row. All ordinary callers retain the bounded
  // default so this does not turn historical reads into unbounded queries.
  if (limit !== null) {
    sql += ' LIMIT ?'
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  }
  const rows = await db.prepare(sql).all(...params)
  const tasks = (rows || []).map(rowToTask)
  if (!withSubmissionProof) return tasks
  // Enrichment only queries for `submitted` tasks (see attachSubmissionProof),
  // so lists of mostly non-terminal tasks pay ~no extra cost.
  for (const task of tasks) await attachSubmissionProof(db, task)
  return tasks
}

/** Exact lifecycle counts, independent of the bounded history page. */
export async function countApplicationTaskBuckets(db, {
  profileId,
  status = null,
  automationType = null,
} = {}) {
  await ensureApplicationTaskSchema(db)
  const params = []
  const sql = appendApplicationTaskFilters(`
    SELECT LOWER(COALESCE(status, '')) AS status, COUNT(*) AS task_count
      FROM application_tasks
     WHERE 1=1
  `, params, { profileId, status, automationType }) + ' GROUP BY LOWER(COALESCE(status, \'\'))'
  const rows = await db.prepare(sql).all(...params)
  const counts = { needs_you: 0, working: 0, waiting: 0, finished: 0, total: 0, unrecognised: 0 }
  for (const row of rows || []) {
    const count = Number(row?.task_count ?? row?.TASK_COUNT ?? row?.count ?? 0) || 0
    const rowStatus = row?.status ?? row?.STATUS ?? ''
    counts[bucketForTaskStatus(rowStatus)] += count
    if (!isRecognisedTaskStatus(rowStatus)) counts.unrecognised += count
    counts.total += count
  }
  return counts
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
  unlessCancelled = false,
  onlyIfStatuses = null,
} = {}) {
  if (!taskId) throw new Error('taskId required')
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`)
  }
  if (automationType !== undefined && !AUTOMATION_TYPES.includes(automationType)) {
    throw new Error(`invalid automationType: ${automationType}`)
  }
  const guardedStatuses = Array.isArray(onlyIfStatuses)
    ? [...new Set(onlyIfStatuses.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  for (const guardedStatus of guardedStatuses) {
    if (!TASK_STATUSES.includes(guardedStatus)) {
      throw new Error(`invalid guarded status: ${guardedStatus}`)
    }
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

  const guards = []
  if (unlessCancelled) {
    // This option is used by asynchronous browser-run conclusions. A stale
    // worker must never overwrite cancellation, a terminal external outcome,
    // or another worker's durable irreversible-boundary lease. The active
    // lease owner uses `onlyIfStatuses` for the two legal forward transitions
    // (`submit_attempt_started` -> `submit_evidence_pending` -> `submitted`).
    guards.push(
      "status NOT IN ('cancelled', 'failed', 'completed', 'submitted', "
      + "'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required')",
    )
  }
  if (guardedStatuses.length > 0) {
    guards.push(`status IN (${guardedStatuses.map(() => '?').join(', ')})`)
  }

  params.push(String(taskId), ...guardedStatuses)
  const sql = `UPDATE application_tasks SET ${sets.join(', ')} WHERE id = ?${guards.length > 0 ? ` AND ${guards.join(' AND ')}` : ''}`
  const touchesManualReceiptIdentity = [
    status,
    currentStep,
    autoSubmitEnabled,
    allowAutoSubmit,
    applicationId,
    universityApplicationId,
    portalId,
    automationType,
    portalUrl,
    applicationUrl,
    outputDocumentId,
    outputPdfDocumentId,
    outputDocxDocumentId,
    outputProposalDocumentId,
    submittedAt,
    completedAt,
  ].some((value) => value !== undefined)

  const executeUpdate = async (targetDb) => {
    try {
      return await targetDb.prepare(sql).run(...params)
    } catch (error) {
      if (isManualReceiptIdentityTriggerError(error)) {
        throw new ActiveManualSubmissionReceiptError()
      }
      throw error
    }
  }

  if (touchesManualReceiptIdentity && typeof db.withTransaction === 'function') {
    // All application writers take the task row first, then inspect the active
    // receipt. Receipt creation/revocation use the same lock order. On
    // PostgreSQL the post-lock SELECT is a new READ COMMITTED statement, so a
    // receipt transaction that won the race cannot be missed by an older
    // statement snapshot.
    await db.withTransaction(async (tx) => {
      const task = await lockTaskAndAssertNoActiveManualReceipt(tx, taskId)
      if (!task) return executeUpdate(tx)
      return executeUpdate(tx)
    })
  } else {
    await executeUpdate(db)
  }
  return await getApplicationTask(db, taskId)
}

/**
 * Acquire the durable external-submission boundary exactly once.
 *
 * The task row is the lease: only a live `filling_portal` task whose canonical
 * stored intent still allows auto-submit and which has never been cancelled can
 * transition to `submit_attempt_started`. Concurrent callers race on one SQL
 * UPDATE, so at most one can acquire. A failed CAS is deliberately descriptive
 * but never mutates the task.
 */
export async function beginSubmissionAttempt(db, taskId, {
  actorUserId = null,
  actorRole = 'agent',
} = {}) {
  if (!taskId) throw new Error('taskId required')
  await ensureApplicationTaskSchema(db)

  const message =
    'Hamilton reached the external submit boundary. Submission evidence must be captured before this task can be marked submitted or retried.'
  const result = await db
    .prepare(
      `UPDATE application_tasks
          SET status = 'submit_attempt_started',
              current_step = 'submit_attempt_started',
              last_agent_message = ?,
              updated_at = ${nowSqlLiteral(db)}
        WHERE id = ?
          AND status = 'filling_portal'
          AND allow_auto_submit IS TRUE
          AND cancelled_at IS NULL`,
    )
    .run(message, String(taskId))

  const acquired = Number(result?.changes ?? result?.rowCount ?? 0) === 1
  let task = await getApplicationTask(db, taskId, { withSubmissionProof: false })
  if (!acquired) {
    let reason = 'compare_and_swap_failed'
    if (!task) reason = 'task_not_found'
    else if (task.status === 'cancelled' || task.cancelled_at) reason = 'task_cancelled'
    else if (task.status !== 'filling_portal') reason = `invalid_status:${task.status}`
    else if (!task.allow_auto_submit) reason = 'auto_submit_disabled'
    return { acquired: false, reason, task }
  }

  await appendTaskEvent(db, {
    taskId,
    eventType: 'progress',
    status: 'submit_attempt_started',
    step: 'submit_attempt_started',
    message,
    actorUserId,
    actorRole,
    details: { irreversible_boundary: true, submission_evidence_required: true },
  })
  task = await getApplicationTask(db, taskId, { withSubmissionProof: false })
  return { acquired: true, reason: null, task }
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

// Portal labels for the SAME field vary ("firstname" / "given_name" /
// "legal_first_name"); without a canonical map each spelling is a different key
// and a flag never matches the profile value (external audit 2026-07-28, the
// #15 remaining-weakness class). Map known synonyms to one canonical segment;
// an unknown segment normalizes to itself (never invents an alias).
const FIELD_ALIASES = Object.freeze({
  firstname: 'first_name', givenname: 'first_name', given_name: 'first_name', legal_first_name: 'first_name', first: 'first_name', fname: 'first_name',
  lastname: 'last_name', surname: 'last_name', familyname: 'last_name', family_name: 'last_name', legal_last_name: 'last_name', last: 'last_name', lname: 'last_name',
  middlename: 'middle_name', legal_middle_name: 'middle_name', middle: 'middle_name',
  zipcode: 'zip_code', zip: 'zip_code', postalcode: 'zip_code', postal_code: 'zip_code',
  telephone: 'phone', phonenumber: 'phone', phone_number: 'phone', mobilephone: 'phone', mobile_phone: 'phone', mobile: 'phone', cellphone: 'phone', cell_phone: 'phone', cell: 'phone',
  emailaddress: 'email', email_address: 'email', e_mail: 'email',
  dob: 'date_of_birth', birthdate: 'date_of_birth', birth_date: 'date_of_birth',
  ssn: 'social_security_number',
  // School (2026-08-30): preflight's reader accepts five spellings but this
  // reconcile map had NO school entry at all, so an editor writing
  // education.current_institution (or Anya writing education.school_name)
  // never cleared a task's school_name ask. One canonical segment.
  school: 'school_name', university: 'school_name', college: 'school_name',
  institution: 'school_name', institution_name: 'school_name',
  current_school: 'school_name', current_institution: 'school_name',
})

function canonicalFieldSegment(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return FIELD_ALIASES[normalized] ?? normalized
}

function canonicalFieldPath(value) {
  return String(value ?? '')
    .split('.')
    .map(canonicalFieldSegment)
    .filter(Boolean)
    .join('.')
}

// Flatten profile_sections rows into a lookup of candidate field keys → value,
// keyed by the CANONICAL dotted path ("basic_information.first_name") so aliases
// collapse to one key. A bare-leaf shortcut ("first_name") is added only when it
// is UNAMBIGUOUS: previously a nested "guardian.first_name" and a top-level
// "first_name" both clobbered the single leaf entry (first-wins), so a bare flag
// could resolve to the wrong person's name (audit #15). Section-root candidates
// (the applicant's OWN field) win the shortcut over deeper nested parties.
function flattenProfileSectionValues(sectionRows) {
  const exact = {}
  const leafCandidates = new Map() // leaf -> [{ path, value }]
  const addLeaf = (leaf, path, value) => {
    if (!leafCandidates.has(leaf)) leafCandidates.set(leaf, [])
    leafCandidates.get(leaf).push({ path, value })
  }
  for (const row of (sectionRows || [])) {
    let data = row?.data
    if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = null } }
    const sectionKey = canonicalFieldSegment(row?.section_key)
    const walk = (obj, parent = []) => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj)) {
        const seg = canonicalFieldSegment(k)
        const nextPath = [...parent, seg]
        if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, nextPath); continue }
        const val = Array.isArray(v) ? v.filter(Boolean).join(', ') : v
        if (val === null || val === undefined || String(val).trim() === '') continue
        const text = String(val)
        const leaf = nextPath[nextPath.length - 1]
        const full = [sectionKey, ...nextPath].filter(Boolean).join('.')
        if (!(full in exact)) exact[full] = text
        addLeaf(leaf, full, text)
      }
    }
    walk(data)
  }
  for (const [leaf, candidates] of leafCandidates) {
    if (leaf in exact) continue
    // Prefer section-root candidates (path depth 2 = "section.leaf" = the
    // applicant's own field) over deeper nested parties sharing the leaf name.
    const roots = candidates.filter((c) => c.path.split('.').length === 2)
    const pool = roots.length ? roots : candidates
    const uniqueValues = [...new Set(pool.map((c) => c.value))]
    if (uniqueValues.length === 1) exact[leaf] = uniqueValues[0]
  }
  return exact
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
 * name" row after the name was added (the Demo Student class, owner report
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
      const leaf = canonicalFieldSegment(k)
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
      // Canonicalize the flagged key the SAME way the profile values were, so a
      // portal's "given_name" flag matches the profile's "first_name" (audit #15).
      const key = canonicalFieldPath(item.key)
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
  const uncertainStatusSql = SUBMISSION_UNCERTAIN_STATUSES
    .map((status) => `'${String(status).replace(/'/g, "''")}'`)
    .join(', ')
  const verificationMessage =
    'Cancellation was requested after Hamilton began the external submit step. The external submission may already be in progress, so confirmation must be verified before this task is retried or marked cancelled.'
  const cancelledMessage = reason || 'Task cancelled.'
  const cancelSql =
      `UPDATE application_tasks
         SET status = CASE
               WHEN status IN (${uncertainStatusSql}) THEN 'submission_verification_required'
               ELSE 'cancelled'
             END,
             current_step = CASE
               WHEN status IN (${uncertainStatusSql}) THEN 'submission_verification_required'
               ELSE current_step
             END,
             last_agent_message = CASE
               WHEN status IN (${uncertainStatusSql}) THEN ?
               ELSE ?
             END,
             cancelled_at = CASE
               WHEN status IN (${uncertainStatusSql}) THEN NULL
               ELSE ${nowSqlLiteral(db)}
             END,
             next_retry_at = NULL,
             auto_submit_enabled = false, allow_auto_submit = false,
             updated_at = ${nowSqlLiteral(db)}
       WHERE id = ?`
  const cancelParams = [verificationMessage, cancelledMessage, String(taskId)]
  const executeCancel = async (targetDb) => {
    try {
      return await targetDb.prepare(cancelSql).run(...cancelParams)
    } catch (error) {
      if (isManualReceiptIdentityTriggerError(error)) {
        throw new ActiveManualSubmissionReceiptError()
      }
      throw error
    }
  }
  if (typeof db.withTransaction === 'function') {
    await db.withTransaction(async (tx) => {
      const task = await lockTaskAndAssertNoActiveManualReceipt(tx, taskId)
      if (!task) return null
      return executeCancel(tx)
    })
  } else {
    await executeCancel(db)
  }

  const task = await getApplicationTask(db, taskId)
  if (!task) return null
  const requiresVerification = task.status === 'submission_verification_required'
  await appendTaskEvent(db, {
    taskId,
    eventType: requiresVerification ? 'note' : 'cancelled',
    status: task.status,
    step: requiresVerification ? 'submission_verification_required' : null,
    message: requiresVerification ? verificationMessage : cancelledMessage,
    actorUserId,
    actorRole,
    details: requiresVerification
      ? { cancel_requested: true, ambiguous_submission: true, reason: reason || null }
      : { reason: reason || null },
  })
  return task
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

/**
 * The moment a credential or captured session APPEARS for a portal, every task
 * parked on that portal's auth wall becomes immediately due (2026-08-30).
 *
 * The auth-backoff ladder's whole promise is "sign in once and Hamilton
 * resumes on her own" — but resumption used to wait for the ladder's next
 * timer (up to 24h after a few retries). This stamps next_retry_at = now on
 * the profile's waiting_for_login / waiting_for_2fa / waiting_for_captcha
 * tasks whose portal/application URL is on the same registrable domain, so
 * the very next scheduler tick re-picks them. Best-effort; never throws.
 *
 * @returns {Promise<{ matched: number, resumed: number }>}
 */
export async function resumeAuthWaitingTasksForHost(db, { profileId, portalHost } = {}) {
  const out = { matched: 0, resumed: 0 }
  if (!db || !profileId || !portalHost) return out
  const wanted = String(portalHost).toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '')
  if (!wanted) return out
  const sameDomain = (raw) => {
    try {
      const h = new URL(String(raw)).hostname.toLowerCase().replace(/^www\./, '')
      return h === wanted || h.endsWith(`.${wanted}`) || wanted.endsWith(`.${h}`)
    } catch { return false }
  }
  try {
    await ensureApplicationTaskSchema(db)
    const rows = await db.prepare(
      `SELECT id, portal_url, application_url FROM application_tasks
        WHERE profile_id = ?
          AND status IN ('waiting_for_login','waiting_for_2fa','waiting_for_captcha')`,
    ).all(String(profileId))
    const nowIso = new Date().toISOString()
    for (const row of rows || []) {
      if (!sameDomain(row.portal_url) && !sameDomain(row.application_url)) continue
      out.matched += 1
      try {
        await db.prepare(
          `UPDATE application_tasks SET next_retry_at = ?, updated_at = ${nowSqlLiteral(db)} WHERE id = ?`,
        ).run(nowIso, row.id)
        out.resumed += 1
        await appendTaskEvent(db, {
          taskId: row.id,
          eventType: 'note',
          status: null,
          step: 'auth_resume',
          message: `A saved login/session for ${wanted} just became available — Hamilton will retry this portal on the next tick instead of waiting out the backoff.`,
          actorRole: 'agent',
          details: { portal_host: wanted, resumed_by: 'credential_or_session_added' },
        }).catch(() => {})
      } catch { /* per-task best-effort */ }
    }
  } catch { /* table absent on bare DBs — nothing to resume */ }
  return out
}

export { rowToTask as _rowToTask, rowToEvent as _rowToEvent, rowToMissing as _rowToMissing }
