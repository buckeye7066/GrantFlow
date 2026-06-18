/**
 * hamiltonApplicationAgent.js
 *
 * Hamilton — application-completion agent. Given a profile + funding
 * opportunity (or an existing application_task), Hamilton:
 *
 *   1. Loads the profile, opportunity, portal link, available documents,
 *      and the current task state.
 *   2. Picks the matching portal adapter from `portalAdapterRegistry`.
 *   3. Asks the adapter to inspect requirements, fill known fields, and
 *      surface any missing fields/documents/login/consent items.
 *   4. Persists everything (status, current step, missing info) back to
 *      `application_tasks` / `application_missing_info` and writes an
 *      audit row to `application_task_events`.
 *   5. Emits a persistent notification (hamilton_missing_info /
 *      hamilton_login_required / hamilton_application_ready / ...) so the user
 *      sees a toast + bell update.
 *   6. Records a `hamilton_runs` row so the agent telemetry / Mission
 *      Control surfaces Hamilton's activity.
 *
 * Hamilton NEVER:
 *   - bypasses CAPTCHA, 2FA, SSO, paywalls, terms-of-service, signatures,
 *     legal attestations, consent boxes, or final-submit confirmation
 *     unless the caller explicitly opts in via task.auto_submit_enabled
 *     === true AND the adapter agrees the portal allows it.
 *   - invents missing answers — every "filled" field is verified to exist
 *     on the profile or in an attached document.
 *   - logs raw passwords or secrets — credentials are referenced by a
 *     `credentials_status` field on student_portals only.
 */

import crypto from 'crypto'
import { resolveAdapter } from './portalAdapters/portalAdapterRegistry.js'
import { ADAPTER_OUTCOMES } from './portalAdapters/portalAdapterTypes.js'
import {
  ensureApplicationTask,
  updateApplicationTask,
  appendTaskEvent,
  setMissingInfo,
  listMissingInfo,
  getApplicationTask,
  TASK_STATUSES,
} from './hamilton/applicationTaskStore.js'
import { getFundingPortalLinkForOpportunity, linkOpportunityToPortal } from './hamilton/studentFundingPortalLinker.js'
import { getStudentPortal } from './hamilton/studentPortalStore.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamilton/hamiltonNotifications.js'
import { withProfileScope } from '../middleware/profileContext.js'
import { prepareApplication, autoPopulate, validateApplication, markSubmitted } from '../apply/applyEngine.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'

export const HAMILTON_AGENT_NAME = 'hamilton'

// ── Configuration / safety toggles ────────────────────────────────

const ENV = (typeof process !== 'undefined' && process?.env) ? process.env : {}

export function isBrowserAutomationEnabled() {
  return String(ENV.HAMILTON_ENABLE_BROWSER_AUTOMATION || 'false').toLowerCase() === 'true'
}

export function isAutoSubmitGloballyEnabled() {
  return String(ENV.HAMILTON_ALLOW_AUTOSUBMIT || 'false').toLowerCase() === 'true'
}

// ── Outcome → task-status mapping ─────────────────────────────────

function outcomeToTaskStatus(outcome) {
  switch (outcome) {
    case ADAPTER_OUTCOMES.READY: return 'ready'
    case ADAPTER_OUTCOMES.WAITING_FOR_USER: return 'waiting_for_user'
    case ADAPTER_OUTCOMES.WAITING_FOR_ADMIN: return 'waiting_for_admin'
    case ADAPTER_OUTCOMES.BLOCKED_LOGIN: return 'blocked_login_required'
    case ADAPTER_OUTCOMES.BLOCKED_2FA: return 'blocked_2fa'
    case ADAPTER_OUTCOMES.BLOCKED_CAPTCHA: return 'blocked_captcha'
    case ADAPTER_OUTCOMES.BLOCKED_TERMS: return 'blocked_terms_or_policy'
    case ADAPTER_OUTCOMES.BLOCKED_MISSING: return 'blocked_missing_info'
    case ADAPTER_OUTCOMES.DRAFT_COMPLETED: return 'draft_completed'
    case ADAPTER_OUTCOMES.SUBMITTED: return 'submitted'
    case ADAPTER_OUTCOMES.FAILED: return 'failed'
    default: return 'queued'
  }
}

function notificationTypeForOutcome(outcome, hasDocs, hasLogin) {
  switch (outcome) {
    case ADAPTER_OUTCOMES.READY: return 'hamilton_application_ready'
    case ADAPTER_OUTCOMES.SUBMITTED: return 'hamilton_application_submitted'
    case ADAPTER_OUTCOMES.DRAFT_COMPLETED: return 'hamilton_review_required'
    case ADAPTER_OUTCOMES.BLOCKED_LOGIN: return 'hamilton_login_required'
    case ADAPTER_OUTCOMES.BLOCKED_2FA:
    case ADAPTER_OUTCOMES.BLOCKED_CAPTCHA:
    case ADAPTER_OUTCOMES.BLOCKED_TERMS:
      return 'hamilton_application_blocked'
    case ADAPTER_OUTCOMES.BLOCKED_MISSING:
      return hasDocs ? 'hamilton_document_required' : 'hamilton_missing_info'
    case ADAPTER_OUTCOMES.WAITING_FOR_USER:
      return hasLogin ? 'hamilton_login_required' : 'hamilton_review_required'
    case ADAPTER_OUTCOMES.WAITING_FOR_ADMIN: return 'hamilton_review_required'
    case ADAPTER_OUTCOMES.FAILED: return 'hamilton_application_failed'
    default: return 'hamilton_review_required'
  }
}

function severityForOutcome(outcome) {
  switch (outcome) {
    case ADAPTER_OUTCOMES.SUBMITTED: return 'success'
    case ADAPTER_OUTCOMES.FAILED: return 'error'
    case ADAPTER_OUTCOMES.READY: return 'info'
    case ADAPTER_OUTCOMES.DRAFT_COMPLETED: return 'info'
    case ADAPTER_OUTCOMES.BLOCKED_LOGIN:
    case ADAPTER_OUTCOMES.BLOCKED_2FA:
    case ADAPTER_OUTCOMES.BLOCKED_CAPTCHA:
    case ADAPTER_OUTCOMES.BLOCKED_TERMS:
      return 'warning'
    case ADAPTER_OUTCOMES.BLOCKED_MISSING: return 'warning'
    default: return 'info'
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function loadProfile(db, profileId) {
  if (!db || !profileId) return null
  await withProfileScope({ bypass: true }, async () => null)
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  if (!row) return null

  // Pull university_applications + basic_information sections so the
  // adapter has the most useful context without hitting the API again.
  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch {
    sectionRows = []
  }
  const sections = {}
  for (const r of sectionRows || []) {
    try {
      sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
    } catch {
      sections[r.section_key] = null
    }
  }

  // "Parse, baby, parse." Read-time safety net: if basic_information only has a
  // full_name (or the profile only has a display_name), derive first_name /
  // last_name on the fly so preflight does not raise false "missing first/last
  // name" blockers even on profiles the backfill migration has not touched yet.
  const derived = deriveNamePartsIntoBasicInfo(sections.basic_information || {}, row.display_name)
  if (derived.changed) sections.basic_information = derived.data

  return { ...row, sections, ...sections }
}

async function loadOpportunity(db, { opportunityId = null, grantId = null }) {
  if (opportunityId) {
    try {
      const row = await db
        .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
        .get(String(opportunityId))
      if (row) return { kind: 'opportunity', ...row }
    } catch { /* table may not exist in tests */ }
  }
  if (grantId) {
    try {
      const row = await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(grantId))
      if (row) return { kind: 'grant', ...row, grant_id: row.id }
    } catch { /* ignore */ }
  }
  return null
}

async function loadDocuments(db, profileId) {
  if (!db || !profileId) return []
  try {
    const rows = await db
      .prepare(
        `SELECT id, type, kind, filename, label, university_application_name
           FROM documents WHERE profile_id = ?`,
      )
      .all(String(profileId))
    return rows || []
  } catch {
    return []
  }
}

async function recordHamiltonRun(db, summary) {
  try {
    const id = crypto.randomUUID()
    const isPostgres = db?.dialect === 'postgres'
    const completedAt = new Date().toISOString()
    await db
      .prepare(
        `INSERT INTO hamilton_runs
           (id, task_id, profile_id, user_id, mode, trigger, status,
            started_at, completed_at,
            application_tasks_processed, fields_filled, missing_info_detected,
            drafts_completed, submissions_completed, blocked_safety,
            notifications_emitted, summary_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        summary.taskId,
        summary.profileId,
        summary.userId,
        summary.mode || 'execute',
        summary.trigger || 'manual',
        summary.error ? 'error' : 'completed',
        completedAt,
        summary.application_tasks_processed || 1,
        summary.fields_filled || 0,
        summary.missing_info_detected || 0,
        summary.drafts_completed || 0,
        summary.submissions_completed || 0,
        summary.blocked_safety || 0,
        summary.notifications_emitted || 0,
        JSON.stringify(summary),
        summary.error || null,
      )
    return id
  } catch {
    // hamilton_runs is advisory — don't fail the agent run if logging fails.
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Public entry point — start a new Hamilton run for a (profile, opportunity).
 * Idempotent: if a task already exists it is reused; this lets the
 * frontend "Let Hamilton continue" button resume mid-flight.
 */
export async function startHamiltonForOpportunity(db, {
  profileId,
  userId = null,
  opportunityId = null,
  grantId = null,
  triggeredBy = null,
  mode = 'execute',
  trigger = 'manual',
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!opportunityId && !grantId) throw new Error('opportunityId or grantId required')

  // Resolve / create the portal link first so the task knows which portal
  // it's targeting.
  let link = await getFundingPortalLinkForOpportunity(db, profileId, { opportunityId, grantId })
  if (!link) {
    const profile = await loadProfile(db, profileId)
    const opportunity = await loadOpportunity(db, { opportunityId, grantId })
    if (profile && opportunity) {
      link = await linkOpportunityToPortal(db, {
        db,
        profile,
        profileId,
        opportunity: { ...opportunity, id: opportunity.id || opportunityId, grant_id: grantId },
        grantId,
        userId,
      })
    }
  }

  const task = await ensureApplicationTask(db, {
    profileId,
    userId,
    opportunityId,
    grantId,
    portalId: link?.portal_id ?? null,
    initialStatus: 'queued',
    currentStep: 'inspect_requirements',
  })

  return await runHamiltonCycle(db, {
    taskId: task.id,
    profileId,
    userId: userId || triggeredBy,
    mode,
    trigger,
  })
}

/**
 * Continue an existing task. Useful when the user has just supplied
 * missing info and wants Hamilton to advance.
 */
export async function continueHamiltonTask(db, { taskId, actorUserId = null, actorRole = null } = {}) {
  if (!db || !taskId) throw new Error('db and taskId required')
  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  return await runHamiltonCycle(db, {
    taskId,
    profileId: task.profile_id,
    userId: actorUserId || task.user_id,
    actorRole,
    mode: 'execute',
    trigger: 'continue',
  })
}

/**
 * The core cycle — load context, run the adapter, persist, notify.
 *
 * Returns {
 *   ok: boolean,
 *   task,                  // updated application_tasks row
 *   adapter_result,        // raw AdapterResult
 *   notification_ids,      // ids inserted into notifications
 *   hamilton_run_id,           // hamilton_runs id
 * }
 */
export async function runHamiltonCycle(db, {
  taskId,
  profileId,
  userId = null,
  actorRole = 'agent',
  mode = 'execute',
  trigger = 'manual',
} = {}) {
  const startedAt = Date.now()

  const task = await getApplicationTask(db, taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  if (task.profile_id && profileId && String(task.profile_id) !== String(profileId)) {
    const err = new Error('profile mismatch — task does not belong to profile')
    err.status = 403
    throw err
  }

  const profile = await loadProfile(db, task.profile_id)
  const opportunity = await loadOpportunity(db, {
    opportunityId: task.opportunity_id,
    grantId: task.grant_id,
  })
  const documents = await loadDocuments(db, task.profile_id)
  const link = await getFundingPortalLinkForOpportunity(db, task.profile_id, {
    opportunityId: task.opportunity_id,
    grantId: task.grant_id,
  })
  const portal = task.portal_id ? await getStudentPortal(db, task.profile_id, task.portal_id) : null

  if (!profile) {
    await appendTaskEvent(db, {
      taskId,
      eventType: 'failed',
      status: 'failed',
      message: 'Profile not found',
      actorUserId: userId,
      actorRole,
    })
    await updateApplicationTask(db, taskId, { status: 'failed', lastAgentMessage: 'Profile not found' })
    return { ok: false, task: await getApplicationTask(db, taskId), error: 'profile_not_found' }
  }

  const adapter = resolveAdapter(link, opportunity, profile)

  const ctx = Object.freeze({
    profile,
    opportunity,
    portalLink: link,
    portal,
    task,
    knownSchool: null,
    documents,
    options: {
      allowSubmit: Boolean(task.auto_submit_enabled) && isAutoSubmitGloballyEnabled(),
      browserAutomation: isBrowserAutomationEnabled(),
    },
  })

  // Always inspect first so we capture the latest list of missing info.
  let result
  try {
    result = adapter.inspectRequirements(ctx)
  } catch (err) {
    await appendTaskEvent(db, {
      taskId,
      eventType: 'failed',
      status: 'failed',
      message: `adapter.inspectRequirements failed: ${err?.message || err}`,
      actorUserId: userId,
      actorRole,
    })
    await updateApplicationTask(db, taskId, { status: 'failed', lastAgentMessage: 'Adapter inspection failed' })
    await recordHamiltonRun(db, {
      taskId, profileId: task.profile_id, userId, mode, trigger,
      error: err?.message || String(err),
    })
    return { ok: false, task: await getApplicationTask(db, taskId), error: 'adapter_inspect_failed' }
  }

  // If we're not blocked on missing info, ask the adapter to fill the
  // application from profile data.
  if (result.outcome === ADAPTER_OUTCOMES.READY) {
    try {
      result = adapter.fillApplication(ctx)
    } catch (err) {
      result = {
        outcome: ADAPTER_OUTCOMES.FAILED,
        message: `fillApplication failed: ${err?.message || err}`,
        requirements: [],
        filled_fields: {},
        submission_method: null,
        submission_reference: null,
        blocking_reason: 'fill_failed',
        safe_to_proceed: false,
      }
    }
  }

  // If the adapter says we can submit AND the task explicitly enabled
  // auto-submit, ask the adapter to attempt submission. Adapters
  // themselves enforce the safety rules.
  if (
    result.outcome === ADAPTER_OUTCOMES.DRAFT_COMPLETED
    && task.auto_submit_enabled
    && isAutoSubmitGloballyEnabled()
  ) {
    try {
      const submitResult = adapter.submitApplication(ctx)
      if (submitResult) result = submitResult
    } catch (err) {
      result = {
        outcome: ADAPTER_OUTCOMES.FAILED,
        message: `submitApplication failed: ${err?.message || err}`,
        requirements: [],
        filled_fields: {},
        submission_method: null,
        submission_reference: null,
        blocking_reason: 'submit_failed',
        safe_to_proceed: false,
      }
    }
  }

  // Optional: integrate with the apply-engine when the portal type is
  // amenable to a draft package (scholarship/external). We use the apply
  // engine to seed sections + checklist for the user. Failure is
  // non-fatal — the agent run still completes with the adapter's outcome.
  let applicationId = task.application_id
  if (
    !applicationId
    && opportunity?.kind === 'grant'
    && task.grant_id
    && profile.organization_id
    && [ADAPTER_OUTCOMES.READY, ADAPTER_OUTCOMES.DRAFT_COMPLETED, ADAPTER_OUTCOMES.WAITING_FOR_USER].includes(result.outcome)
  ) {
    try {
      const app = await prepareApplication({
        db,
        grantId: task.grant_id,
        organizationId: profile.organization_id,
        userId,
      })
      applicationId = app?.id ?? null
      if (applicationId && result.outcome === ADAPTER_OUTCOMES.READY) {
        await autoPopulate({ db, applicationId }).catch(() => null)
        await validateApplication({ db, applicationId }).catch(() => null)
      }
    } catch (_err) {
      applicationId = task.application_id
    }
  }

  // Persist task state
  const taskStatus = outcomeToTaskStatus(result.outcome)
  const missingFieldsArr = result.requirements.filter((r) => r.kind === 'field')
  const missingDocsArr = result.requirements.filter((r) => r.kind === 'document')
  const userActionsArr = result.requirements.filter((r) => ['login', 'consent', 'signature', 'attestation', 'admin_review', 'other'].includes(r.kind))

  await updateApplicationTask(db, taskId, {
    status: taskStatus,
    currentStep: deriveStepFromOutcome(result.outcome),
    missingFields: missingFieldsArr,
    missingDocuments: missingDocsArr,
    requiredUserActions: userActionsArr,
    lastAgentMessage: result.message,
    applicationId: applicationId === undefined ? undefined : applicationId,
  })
  if (result.requirements?.length) {
    await setMissingInfo(db, taskId, result.requirements)
  }

  // If the adapter signalled SUBMITTED and we have an apply-engine row,
  // mirror the submission so the rest of the system knows.
  if (result.outcome === ADAPTER_OUTCOMES.SUBMITTED && applicationId) {
    let mirrored = false
    try {
      await markSubmitted({
        db,
        applicationId,
        method: result.submission_method || 'portal',
        metadata: {
          submitted_by: 'hamilton',
          submission_reference: result.submission_reference || null,
          task_id: taskId,
        },
      })
      mirrored = true
    } catch (err) {
      // Never claim a submission we did not actually record. If the
      // apply-engine mirror fails, log it and DO NOT mark the task submitted —
      // leave it for review instead of falsely showing "submitted".
      console.warn(`[hamilton] markSubmitted failed for task ${taskId}; not marking submitted: ${err?.message || err}`)
    }
    if (mirrored) {
      await updateApplicationTask(db, taskId, { submittedAt: new Date().toISOString() })
    }
  }

  await appendTaskEvent(db, {
    taskId,
    eventType: outcomeToEventType(result.outcome),
    status: taskStatus,
    step: deriveStepFromOutcome(result.outcome),
    message: result.message,
    details: {
      adapter: adapter.name,
      filled_fields_count: Object.keys(result.filled_fields || {}).length,
      missing_count: result.requirements.length,
      blocking_reason: result.blocking_reason,
    },
    actorUserId: userId,
    actorRole,
  })

  // Notification — only emit when there's an actionable update.
  let notificationIds = []
  const notificationType = notificationTypeForOutcome(
    result.outcome,
    missingDocsArr.length > 0,
    userActionsArr.some((u) => u.kind === 'login'),
  )
  if (notificationType) {
    notificationIds = await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: profile.user_id || task.user_id || null,
      type: notificationType,
      title: titleForNotification(notificationType, opportunity, profile),
      message: result.message || messageForNotification(notificationType, opportunity, profile),
      severity: severityForOutcome(result.outcome),
      data: {
        task_id: taskId,
        profile_id: task.profile_id,
        opportunity_id: task.opportunity_id,
        grant_id: task.grant_id,
        portal_id: task.portal_id,
        portal_type: link?.portal_type || null,
        application_url: link?.application_url || null,
        deadline: opportunity?.deadline || null,
        student_name: profile.display_name || `${readPath(profile, 'basic_information.first_name') || ''} ${readPath(profile, 'basic_information.last_name') || ''}`.trim(),
        funding_source_name: opportunity?.title || opportunity?.name || null,
        cta_url: link?.application_url || opportunity?.application_url || null,
      },
    })
  }

  await recordHamiltonRun(db, {
    taskId,
    profileId: task.profile_id,
    userId,
    mode,
    trigger,
    application_tasks_processed: 1,
    fields_filled: Object.keys(result.filled_fields || {}).length,
    missing_info_detected: result.requirements.length,
    drafts_completed: result.outcome === ADAPTER_OUTCOMES.DRAFT_COMPLETED ? 1 : 0,
    submissions_completed: result.outcome === ADAPTER_OUTCOMES.SUBMITTED ? 1 : 0,
    blocked_safety: [
      ADAPTER_OUTCOMES.BLOCKED_2FA,
      ADAPTER_OUTCOMES.BLOCKED_CAPTCHA,
      ADAPTER_OUTCOMES.BLOCKED_TERMS,
      ADAPTER_OUTCOMES.BLOCKED_LOGIN,
    ].includes(result.outcome) ? 1 : 0,
    notifications_emitted: notificationIds.length,
    duration_ms: Date.now() - startedAt,
    adapter_name: adapter.name,
  })

  return {
    ok: true,
    task: await getApplicationTask(db, taskId),
    missing_info: await listMissingInfo(db, taskId, { includeResolved: false }),
    adapter_result: result,
    adapter_name: adapter.name,
    notification_ids: notificationIds,
  }
}

function outcomeToEventType(outcome) {
  switch (outcome) {
    case ADAPTER_OUTCOMES.SUBMITTED: return 'submitted'
    case ADAPTER_OUTCOMES.DRAFT_COMPLETED: return 'draft_completed'
    case ADAPTER_OUTCOMES.READY: return 'progress'
    case ADAPTER_OUTCOMES.BLOCKED_LOGIN:
    case ADAPTER_OUTCOMES.BLOCKED_2FA:
    case ADAPTER_OUTCOMES.BLOCKED_CAPTCHA:
    case ADAPTER_OUTCOMES.BLOCKED_TERMS:
    case ADAPTER_OUTCOMES.BLOCKED_MISSING:
      return 'blocked'
    case ADAPTER_OUTCOMES.WAITING_FOR_USER:
    case ADAPTER_OUTCOMES.WAITING_FOR_ADMIN:
      return 'missing_info'
    case ADAPTER_OUTCOMES.FAILED: return 'failed'
    default: return 'progress'
  }
}

function deriveStepFromOutcome(outcome) {
  switch (outcome) {
    case ADAPTER_OUTCOMES.READY: return 'fill_application'
    case ADAPTER_OUTCOMES.DRAFT_COMPLETED: return 'awaiting_user_review'
    case ADAPTER_OUTCOMES.SUBMITTED: return 'submitted'
    case ADAPTER_OUTCOMES.BLOCKED_LOGIN: return 'awaiting_login'
    case ADAPTER_OUTCOMES.BLOCKED_MISSING: return 'awaiting_missing_info'
    case ADAPTER_OUTCOMES.BLOCKED_2FA: return 'awaiting_2fa'
    case ADAPTER_OUTCOMES.BLOCKED_CAPTCHA: return 'awaiting_captcha'
    case ADAPTER_OUTCOMES.BLOCKED_TERMS: return 'awaiting_terms_acceptance'
    default: return 'inspect_requirements'
  }
}

function titleForNotification(type, opportunity, profile) {
  const studentName = readPath(profile, 'basic_information.first_name') || profile?.display_name || 'Student'
  const oppTitle = opportunity?.title || opportunity?.name || 'a funding opportunity'
  switch (type) {
    case 'hamilton_application_ready': return `Hamilton drafted ${oppTitle}`
    case 'hamilton_application_submitted': return `Application submitted: ${oppTitle}`
    case 'hamilton_review_required': return `Review required for ${oppTitle}`
    case 'hamilton_login_required': return `Login required for ${oppTitle}`
    case 'hamilton_document_required': return `Document needed for ${oppTitle}`
    case 'hamilton_missing_info': return `Missing information for ${oppTitle}`
    case 'hamilton_application_blocked': return `Hamilton blocked on ${oppTitle}`
    case 'hamilton_application_failed': return `Hamilton failed on ${oppTitle}`
    default: return `Hamilton update for ${studentName}`
  }
}

function messageForNotification(type, opportunity, _profile) {
  const oppTitle = opportunity?.title || opportunity?.name || 'this funding opportunity'
  switch (type) {
    case 'hamilton_application_ready': return `Hamilton finished a draft for ${oppTitle}. Review and approve to submit.`
    case 'hamilton_application_submitted': return `Hamilton submitted ${oppTitle}.`
    case 'hamilton_review_required': return `${oppTitle} needs human review.`
    case 'hamilton_login_required': return `Hamilton needs you to log in to the school portal for ${oppTitle}.`
    case 'hamilton_document_required': return `Hamilton needs an uploaded document for ${oppTitle}.`
    case 'hamilton_missing_info': return `Hamilton needs additional information for ${oppTitle}.`
    case 'hamilton_application_blocked': return `Hamilton hit a security check (CAPTCHA/2FA/terms) on ${oppTitle}.`
    case 'hamilton_application_failed': return `Hamilton could not complete ${oppTitle}.`
    default: return `Hamilton has an update on ${oppTitle}.`
  }
}

function readPath(obj, path) {
  if (!obj) return undefined
  const parts = String(path || '').split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}

export {
  outcomeToTaskStatus as _outcomeToTaskStatus,
  notificationTypeForOutcome as _notificationTypeForOutcome,
}
