/**
 * /api/hamilton/automation/*
 *
 * Top-level "Automate with Hamilton" surface. Adds the bulk select-many
 * entry point and channel-specific submission acks (mark-mailed,
 * mark-emailed, mark-faxed) on top of the existing
 * /api/application-tasks endpoints.
 *
 * Endpoints:
 *   POST   /api/hamilton/automation/start                       — bulk start automation for selected sources
 *   POST   /api/hamilton/automation/tasks/:taskId/regenerate    — regenerate the packet (e.g. after profile edits)
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-mailed   — record physical mail submission
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-emailed  — record email submission
 *   POST   /api/hamilton/automation/tasks/:taskId/mark-faxed    — record fax submission
 *   POST   /api/hamilton/automation/tasks/:taskId/approve       — explicit user approval to submit
 *   GET    /api/hamilton/automation/tasks                       — list automation tasks scoped to caller
 *   GET    /api/hamilton/automation/tasks/:taskId               — fetch one with classification + outputs
 *
 * All routes require the caller to be authenticated. Mutations require
 * the caller to own (or be an admin for) the target profile.
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import {
  getApplicationTask,
  listApplicationTasks,
  updateApplicationTask,
  appendTaskEvent,
  listTaskEvents,
  listMissingInfo,
} from '../services/hamilton/applicationTaskStore.js'
import {
  automateSelected,
  automateSingleSource,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { generateAndSavePacket } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'
import { emitHamiltonNotificationToProfileAndAdmins } from '../services/hamilton/hamiltonNotifications.js'
import {
  recordAuthorizations,
  revokeAuthorization,
  getAuthorizationById,
  listActiveAuthorizations,
  HAMILTON_AUTHORIZATION_TYPES,
  listAutopilotRuns,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import {
  preflightSelected,
  readAuthorizations,
} from '../services/hamilton/hamiltonPreflight.js'
import { preflightAndResolveSelected } from '../services/hamilton/hamiltonPreflightResolver.js'
import { listPortalProviders } from '../services/hamilton/hamiltonPortalProviders.js'
import {
  authorizePayment,
  canPayFor,
  revokePaymentAuthorization,
  getPaymentAuthorizationById,
  listPaymentAuthorizations,
  PAYMENT_CATEGORIES,
} from '../services/hamilton/hamiltonPaymentAuthorizationService.js'
import {
  recordSession,
  listSessionsForProfile,
  getSessionById,
  revokeSession,
  markSessionExpired,
} from '../services/hamilton/hamiltonCredentialSessionService.js'
import {
  authorizeAttestation,
  revokeAttestation,
  getAttestationById,
  listActiveAttestations,
  ATTESTATION_CATEGORIES,
} from '../services/hamilton/hamiltonAttestationStore.js'
import {
  getPolicyFor,
  upsertPolicy,
  listPolicies,
} from '../services/hamilton/hamiltonPortalPolicyRegistry.js'
import {
  saveResolvedField,
  listResolvedFields,
} from '../services/hamilton/hamiltonResolvedFieldStore.js'
import {
  listBlockersForTask,
  listOpenAdminBlockers,
  resolveOpenBlockersForTask,
} from '../services/hamilton/hamiltonBlockerStore.js'
import { resolveBlocker } from '../services/hamilton/hamiltonHardStopResolver.js'
import { isAdminUser, HAMILTON_ADMIN_EMAIL } from '../services/hamilton/hamiltonAdminAccount.js'
import { markNotificationsResolved } from '../services/hamilton/hamiltonNotifications.js'
import { createLogger } from '../utils/logger.js'

export const HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT = (
  'Hamilton will attempt to complete and submit the selected application(s) '
  + 'automatically using the profile information and authorized documents on file. '
  + 'Hamilton may open portals, fill forms, upload documents, save drafts, and submit '
  + 'applications when allowed. Hamilton will only stop if required information, '
  + 'documents, credentials, CAPTCHA, 2FA, payment, or a legally personal '
  + 'attestation is required and not already authorized.'
)
export const HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION = 'hamilton-autopilot-v1'

const log = createLogger('route:hamilton-automation')

const router = express.Router()

const startLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 60_000 },
})

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (user?.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // global access
  return accessible.has(String(profileId))
}

async function loadProfile(db, profileId) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    return row || null
  } catch { return null }
}

async function loadTaskAndAuthorise(req, res, taskId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const task = await getApplicationTask(req.db, String(taskId))
  if (!task) {
    res.status(404).json({ error: 'task_not_found' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, task.profile_id))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { user, task }
}

// Auth + profile-scope guard for routes that take an explicit profileId from
// the request (query or body). Sends 401 / 400 / 403 and returns null on
// failure; otherwise returns the authenticated user. Centralizing this closes
// the gap where the payment / session / attestation / resolved-field surfaces
// trusted a caller-supplied profileId without verifying access (cross-profile
// bleed).
async function requireProfileScope(req, res, profileId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const pid = String(profileId || '').trim()
  if (!pid) {
    res.status(400).json({ error: 'profileId required' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, pid))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return user
}

// Auth + ownership guard for :id routes on profile-scoped records. Loads the
// owning row via loader(db, id), 404s if missing, then verifies the caller may
// access the row's profile before any mutation (revoke / expire). Returns
// { user, row } or null after the response has been sent.
async function requireRecordOwnership(req, res, id, loader) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  const row = await loader(req.db, String(id))
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (!(await userMayAccessProfile(req, user, row.profile_id))) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { user, row }
}

router.post('/start', startLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources
    : Array.isArray(req.body?.selectedSources) ? req.body.selectedSources
    : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const result = await automateSelected(req.db, {
      profileId,
      userId: user.id,
      selectedSources,
      options: {
        generate_pdf: req.body?.options?.generate_pdf !== false,
        generate_docx: req.body?.options?.generate_docx !== false,
        portal_automation: req.body?.options?.portal_automation !== false,
      },
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    log.error('automate_selected_failed', { profileId, err: err?.message })
    return res.status(err?.status || 500).json({ error: 'automation_failed', detail: err?.message })
  }
})

router.get('/tasks', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const status = req.query.status ? String(req.query.status) : null
  const automationType = req.query.automation_type ? String(req.query.automation_type) : null
  const profileIdParam = req.query.profile_id || req.query.profileId || null

  try {
    let tasks
    if (user.role === 'admin' && profileIdParam) {
      tasks = await listApplicationTasks(req.db, { profileId: String(profileIdParam), status, limit: 200 })
    } else if (user.role === 'admin') {
      tasks = await listApplicationTasks(req.db, { status, limit: 200 })
    } else {
      const accessible = await getAccessibleProfileIds(req.db, user)
      if (!accessible || accessible.size === 0) return res.json({ ok: true, tasks: [] })
      const all = []
      for (const pid of accessible) {
        const some = await listApplicationTasks(req.db, { profileId: pid, status, limit: 200 })
        all.push(...some)
      }
      tasks = all
    }
    if (automationType) {
      tasks = (tasks || []).filter((t) => t.automation_type === automationType)
    }
    return res.json({ ok: true, tasks })
  } catch (err) {
    log.error('list_tasks_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

router.get('/tasks/:taskId', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const events = await listTaskEvents(req.db, ctx.task.id, { limit: 500 })
    const missing = await listMissingInfo(req.db, ctx.task.id, { includeResolved: true })
    return res.json({ ok: true, task: ctx.task, events, missing })
  } catch (err) {
    log.error('get_task_failed', { taskId: ctx.task.id, err: err?.message })
    return res.status(500).json({ error: 'get_failed' })
  }
})

router.post('/tasks/:taskId/regenerate', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const opportunity = ctx.task.opportunity_id
      ? await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(ctx.task.opportunity_id)).catch(() => null)
      : null
    const grant = ctx.task.grant_id
      ? await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(ctx.task.grant_id)).catch(() => null)
      : null

    const result = await generateAndSavePacket(req.db, {
      profile,
      opportunity,
      grant,
      automationType: ctx.task.automation_type || 'pdf_docx',
      taskId: ctx.task.id,
      userId: ctx.user.id,
    })
    await updateApplicationTask(req.db, ctx.task.id, {
      outputDocxDocumentId: result.docx_document_id,
      outputPdfDocumentId: result.pdf_document_id || null,
      outputDocumentId: result.pdf_document_id || result.docx_document_id,
      mailingInstructions: result.mailing_instructions,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'progress',
      step: 'regenerate',
      message: 'Packet regenerated by user request.',
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role === 'admin' ? 'admin' : 'user',
      details: { docx_document_id: result.docx_document_id, pdf_document_id: result.pdf_document_id },
    })
    return res.json({ ok: true, packet: result })
  } catch (err) {
    log.error('regenerate_failed', { err: err?.message })
    return res.status(500).json({ error: 'regenerate_failed', detail: err?.message })
  }
})

async function markChannelSubmitted(req, res, channel) {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const submittedAt = new Date().toISOString()
  const note = String(req.body?.note || '').slice(0, 1000) || `User confirmed ${channel} submission.`
  try {
    await updateApplicationTask(req.db, ctx.task.id, {
      status: 'submitted',
      submittedAt,
      completedAt: submittedAt,
      lastAgentMessage: note,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'submitted',
      status: 'submitted',
      message: note,
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role === 'admin' ? 'admin' : 'user',
      details: { channel },
    })
    await emitHamiltonNotificationToProfileAndAdmins(req.db, {
      profileId: ctx.task.profile_id,
      profileUserId: ctx.task.user_id,
      type: 'hamilton_submitted',
      title: `Hamilton logged a ${channel.toUpperCase()} submission`,
      message: note,
      severity: 'success',
      data: { task_id: ctx.task.id, channel, submitted_at: submittedAt },
    })
    return res.json({ ok: true, task: await getApplicationTask(req.db, ctx.task.id) })
  } catch (err) {
    log.error('mark_channel_failed', { channel, err: err?.message })
    return res.status(500).json({ error: 'mark_failed', detail: err?.message })
  }
}

router.post('/tasks/:taskId/mark-mailed', (req, res) => markChannelSubmitted(req, res, 'mail'))
router.post('/tasks/:taskId/mark-emailed', (req, res) => markChannelSubmitted(req, res, 'email'))
router.post('/tasks/:taskId/mark-faxed', (req, res) => markChannelSubmitted(req, res, 'fax'))

router.post('/tasks/:taskId/approve', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    await updateApplicationTask(req.db, ctx.task.id, {
      allowAutoSubmit: true,
      autoSubmitEnabled: true,
    })
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      step: 'approve_submit',
      message: 'User explicitly approved auto-submission.',
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role === 'admin' ? 'admin' : 'user',
    })
    return res.json({ ok: true, task: await getApplicationTask(req.db, ctx.task.id) })
  } catch (err) {
    log.error('approve_failed', { err: err?.message })
    return res.status(500).json({ error: 'approve_failed' })
  }
})

router.post('/tasks/:taskId/retry', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  // Re-run the orchestrator on this single source.
  try {
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const result = await automateSingleSource(req.db, {
      profile,
      profileId: ctx.task.profile_id,
      userId: ctx.user.id,
      source: {
        opportunity_id: ctx.task.opportunity_id,
        grant_id: ctx.task.grant_id,
        current_stage: ctx.task.current_pipeline_stage || ctx.task.selected_from_stage,
      },
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    log.error('retry_failed', { err: err?.message })
    return res.status(500).json({ error: 'retry_failed', detail: err?.message })
  }
})

// ── Phase A — Hamilton Autopilot authorization ─────────────────────────

router.post('/authorize', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const scope = String(req.body?.scope || 'task')
  const fundingSourceIds = Array.isArray(req.body?.funding_source_ids) ? req.body.funding_source_ids : []
  const taskIds = Array.isArray(req.body?.task_ids) ? req.body.task_ids : []
  const authorizationTypesIn = Array.isArray(req.body?.authorization_types) ? req.body.authorization_types : []
  const options = req.body?.options || {}
  const authorizationText = String(req.body?.authorization_text || HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT)
  const authorizationVersion = String(req.body?.authorization_version || HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION)

  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const types = authorizationTypesIn.filter((t) => HAMILTON_AUTHORIZATION_TYPES.includes(t))
  if (types.length === 0) return res.status(400).json({ error: 'authorization_types_required' })

  try {
    const ids = await recordAuthorizations(req.db, {
      userId: user.id,
      profileId,
      scope,
      fundingSourceIds,
      taskIds,
      authorizationTypes: types,
      authorizationText,
      authorizationVersion,
      options,
      metadata: {
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        user_agent: req.headers['user-agent'] || null,
        accepted_at: new Date().toISOString(),
      },
    })
    return res.json({ ok: true, authorization_ids: ids, authorization_text: authorizationText, authorization_version: authorizationVersion })
  } catch (err) {
    log.error('authorize_failed', { err: err?.message })
    return res.status(500).json({ error: 'authorize_failed', detail: err?.message })
  }
})

router.get('/authorizations', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.query?.profile_id || req.query?.profileId || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const fundingSourceId = req.query?.funding_source_id ? String(req.query.funding_source_id) : null
  const taskId = req.query?.task_id ? String(req.query.task_id) : null
  try {
    const list = await listActiveAuthorizations(req.db, { profileId, fundingSourceId, taskId })
    const flags = await readAuthorizations(req.db, { profileId, fundingSourceId, taskId })
    return res.json({ ok: true, active: list, flags })
  } catch (err) {
    log.error('list_auth_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

router.post('/authorizations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getAuthorizationById)
  if (!ctx) return
  try {
    const row = await revokeAuthorization(req.db, { id: req.params.id, reason: req.body?.reason || null })
    return res.json({ ok: true, authorization: row })
  } catch (err) {
    log.error('revoke_failed', { err: err?.message })
    return res.status(500).json({ error: 'revoke_failed' })
  }
})

// ── Phase B — Preflight (gather missing inputs before launch) ──────

router.post('/preflight', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) return res.status(403).json({ error: 'forbidden' })
  try {
    const profile = await loadProfile(req.db, profileId)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const report = await preflightSelected(req.db, { profile, profileId, selectedSources })
    return res.json({ ok: true, ...report })
  } catch (err) {
    log.error('preflight_failed', { err: err?.message })
    return res.status(500).json({ error: 'preflight_failed', detail: err?.message })
  }
})

// ── Phase C — Start Autopilot (preflight → unattended run) ─────────

router.post('/start-autopilot', startLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  const selectedSources = Array.isArray(req.body?.selected_sources) ? req.body.selected_sources : []
  if (!profileId) return res.status(400).json({ error: 'profile_id_required' })
  if (selectedSources.length === 0) return res.status(400).json({ error: 'selected_sources_required' })
  if (!(await userMayAccessProfile(req, user, profileId))) return res.status(403).json({ error: 'forbidden' })
  try {
    const result = await automateSelected(req.db, {
      profileId,
      userId: user.id,
      selectedSources,
      options: {
        autopilot: true,
        allow_auto_submit: req.body?.options?.allow_auto_submit !== false,
        documents: Array.isArray(req.body?.options?.documents) ? req.body.options.documents : [],
        storageStatePath: req.body?.options?.storage_state_path || null,
        headless: req.body?.options?.headless !== false,
      },
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    log.error('start_autopilot_failed', { err: err?.message })
    return res.status(err?.status || 500).json({ error: 'start_failed', detail: err?.message })
  }
})

// ── Phase D — Resolve a hard blocker and continue ───────────────────

router.post('/tasks/:taskId/resolve-blocker', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const note = String(req.body?.note || '').slice(0, 1000)
  try {
    // 1. Mark every open blocker for this task as resolved + write
    //    audit row(s) + clear the related persistent notifications so
    //    the bell stops nagging.
    const resolvedBlockers = await resolveOpenBlockersForTask(req.db, {
      taskId: ctx.task.id,
      strategy: 'user_action',
      detail: note || null,
      resolvedByUserId: ctx.user.id,
    })
    for (const b of resolvedBlockers) {
      const ids = []
      if (b.user_notification_id) ids.push(b.user_notification_id)
      ids.push(...(b.admin_notification_ids || []))
      if (ids.length > 0) await markNotificationsResolved(req.db, ids)
    }
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'note',
      step: 'resolve_blocker',
      message: note || 'User indicated the blocker is resolved. Re-running Hamilton Autopilot.',
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role === 'admin' ? 'admin' : 'user',
      details: { resolved_blocker_ids: resolvedBlockers.map((b) => b.id) },
    })
    const profile = await loadProfile(req.db, ctx.task.profile_id)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const result = await automateSingleSource(req.db, {
      profile,
      profileId: ctx.task.profile_id,
      userId: ctx.user.id,
      source: {
        opportunity_id: ctx.task.opportunity_id,
        grant_id: ctx.task.grant_id,
        task_id: ctx.task.id,
        current_stage: ctx.task.current_pipeline_stage || ctx.task.selected_from_stage,
      },
      options: { autopilot: true, allow_auto_submit: true },
    })
    return res.json({ ok: true, resolved_blockers: resolvedBlockers, ...result })
  } catch (err) {
    log.error('resolve_blocker_failed', { err: err?.message })
    return res.status(500).json({ error: 'resolve_failed', detail: err?.message })
  }
})

// ── Phase F — Provider catalogue ───────────────────────────────────

router.get('/providers', async (_req, res) => {
  try {
    const providers = await listPortalProviders()
    return res.json({ ok: true, providers })
  } catch (err) {
    log.error('list_providers_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Autopilot-run history per task.
router.get('/tasks/:taskId/autopilot-runs', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const runs = await listAutopilotRuns(req.db, { taskId: ctx.task.id, limit: 50 })
    return res.json({ ok: true, runs })
  } catch (err) {
    log.error('list_runs_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// ── Hard-Stop Resolver routes ─────────────────────────────────────

// Extended resolver-aware preflight. Returns full readiness readout
// per source plus the resolutions Hamilton already applied.
router.post('/preflight-resolve', async (req, res) => {
  const { profileId, selectedSources = [] } = req.body || {}
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  try {
    const profile = await loadProfile(req.db, profileId)
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    const result = await preflightAndResolveSelected(req.db, {
      profile, profileId, selectedSources, userId: user.id,
    })
    return res.json(result)
  } catch (err) {
    log.error('preflight_resolve_failed', { err: err?.message })
    return res.status(500).json({ error: 'preflight_resolve_failed', detail: err?.message })
  }
})

// Payment authorizations. Token/reference-only — these stores never hold raw
// card data — but they are still profile-scoped secrets, so every read and
// write verifies the caller may access the target profile.
router.get('/payment-authorizations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  try {
    const list = await listPaymentAuthorizations(req.db, req.query.profileId)
    return res.json({ ok: true, payment_categories: PAYMENT_CATEGORIES, authorizations: list })
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', detail: err?.message })
  }
})
router.post('/payment-authorizations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const auth = await authorizePayment(req.db, { ...req.body, userId: user.id })
    return res.json({ ok: true, authorization: auth })
  } catch (err) {
    return res.status(400).json({ error: 'authorize_failed', detail: err?.message })
  }
})
router.post('/payment-authorizations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getPaymentAuthorizationById)
  if (!ctx) return
  const auth = await revokePaymentAuthorization(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, authorization: auth })
})
router.get('/payment-authorizations/can-pay', async (req, res) => {
  const { profileId, category, amountCents, portalHost } = req.query
  const user = await requireProfileScope(req, res, profileId)
  if (!user) return
  if (!category) return res.status(400).json({ error: 'category required' })
  const decision = await canPayFor(req.db, {
    profileId, category, amountCents: Number(amountCents || 0), portalHost: portalHost || null,
  })
  return res.json(decision)
})

// Saved sessions. Storage stores only Playwright storage-state references /
// paths — never plaintext credentials — and is profile-scoped.
router.get('/sessions', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listSessionsForProfile(req.db, req.query.profileId)
  return res.json({ ok: true, sessions: list })
})
router.post('/sessions', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const session = await recordSession(req.db, { ...req.body, userId: user.id })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(400).json({ error: 'record_failed', detail: err?.message })
  }
})
router.post('/sessions/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getSessionById)
  if (!ctx) return
  const session = await revokeSession(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, session })
})
router.post('/sessions/:id/expire', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getSessionById)
  if (!ctx) return
  const session = await markSessionExpired(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, session })
})

// Standing attestations.
router.get('/attestations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listActiveAttestations(req.db, req.query.profileId)
  return res.json({ ok: true, categories: ATTESTATION_CATEGORIES, attestations: list })
})
router.post('/attestations', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const auth = await authorizeAttestation(req.db, { ...req.body, userId: user.id })
    return res.json({ ok: true, attestation: auth })
  } catch (err) {
    return res.status(400).json({ error: 'authorize_failed', detail: err?.message })
  }
})
router.post('/attestations/:id/revoke', async (req, res) => {
  const ctx = await requireRecordOwnership(req, res, req.params.id, getAttestationById)
  if (!ctx) return
  const auth = await revokeAttestation(req.db, req.params.id, req.body?.reason || null)
  return res.json({ ok: true, attestation: auth })
})

// Portal policies govern what Hamilton is *allowed* to do on a given portal
// host (a legal/safety control), so writes are restricted to the canonical
// admin and reads require authentication.
router.get('/portal-policies', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (req.query.host) {
    const policy = await getPolicyFor(req.db, req.query.host)
    return res.json({ ok: true, policy })
  }
  const list = await listPolicies(req.db)
  return res.json({ ok: true, policies: list })
})
router.post('/portal-policies', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const policy = await upsertPolicy(req.db, req.body || {})
    return res.json({ ok: true, policy })
  } catch (err) {
    return res.status(400).json({ error: 'upsert_failed', detail: err?.message })
  }
})

// Resolved fields.
router.get('/resolved-fields', async (req, res) => {
  const user = await requireProfileScope(req, res, req.query.profileId)
  if (!user) return
  const list = await listResolvedFields(req.db, req.query.profileId)
  return res.json({ ok: true, fields: list })
})
router.post('/resolved-fields', async (req, res) => {
  const user = await requireProfileScope(req, res, req.body?.profileId)
  if (!user) return
  try {
    const field = await saveResolvedField(req.db, { ...req.body, userId: user.id })
    return res.json({ ok: true, field })
  } catch (err) {
    return res.status(400).json({ error: 'save_failed', detail: err?.message })
  }
})

// Admin: dashboard list of every open hard stop in the system. Restricted to
// the canonical Hamilton operator (buckeye7066@gmail.com). Multi-admin routing
// is *not* the primary path — this endpoint accepts is_admin=1 OR an email
// that matches the canonical admin email.
router.get('/admin/hard-stops', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '200', 10) || 200))
    const blockers = await listOpenAdminBlockers(req.db, { limit })
    return res.json({ ok: true, blockers, admin_email: HAMILTON_ADMIN_EMAIL })
  } catch (err) {
    log.error('admin_hard_stops_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Admin: aggregated counts + recent task list for the canonical admin
// dashboard. Used by AdminHamiltonHardStops to render the four columns
// (pending hard stops / active / failed / completed) with a single
// round-trip.
router.get('/admin/tasks', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) return res.status(403).json({ error: 'forbidden_admin_only' })
  try {
    const status = String(req.query.status || 'all').toLowerCase()
    const allowed = new Set(['all', 'active', 'blocked', 'failed', 'completed'])
    const filter = allowed.has(status) ? status : 'all'
    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '100', 10) || 100))

    let where = ''
    const params = []
    if (filter === 'active') {
      where = "WHERE status IN ('queued','running','waiting_for_review','in_progress')"
    } else if (filter === 'blocked') {
      where = "WHERE status = 'blocked'"
    } else if (filter === 'failed') {
      where = "WHERE status = 'failed'"
    } else if (filter === 'completed') {
      where = "WHERE status IN ('submitted','completed','completed_draft')"
    }
    const rows = await req.db.prepare(
      `SELECT id, profile_id, user_id, opportunity_id, grant_id, status,
              automation_type, last_agent_message, updated_at, created_at
         FROM application_tasks
         ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
    ).all(...params, limit)
    return res.json({ ok: true, tasks: rows || [], filter, admin_email: HAMILTON_ADMIN_EMAIL })
  } catch (err) {
    log.error('admin_tasks_failed', { err: err?.message })
    return res.status(500).json({ error: 'list_failed' })
  }
})

// Cancel a Hamilton task. Resolves all open blockers and stops automation.
router.post('/tasks/:taskId/cancel', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const reason = String(req.body?.reason || '').slice(0, 500) || 'cancelled_by_user'
  try {
    const resolvedBlockers = await resolveOpenBlockersForTask(req.db, {
      taskId: ctx.task.id,
      strategy: 'cancelled',
      detail: reason,
      resolvedByUserId: ctx.user.id,
    })
    for (const b of resolvedBlockers) {
      const ids = [b.user_notification_id, ...(b.admin_notification_ids || [])].filter(Boolean)
      if (ids.length > 0) await markNotificationsResolved(req.db, ids)
    }
    await appendTaskEvent(req.db, {
      taskId: ctx.task.id,
      eventType: 'cancelled',
      step: 'cancel',
      message: reason,
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role === 'admin' ? 'admin' : 'user',
    })
    return res.json({ ok: true, resolved_blockers: resolvedBlockers })
  } catch (err) {
    log.error('cancel_task_failed', { err: err?.message })
    return res.status(500).json({ error: 'cancel_failed', detail: err?.message })
  }
})

// Blockers.
router.get('/tasks/:taskId/blockers', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  const onlyOpen = String(req.query.onlyOpen || 'false').toLowerCase() === 'true'
  const list = await listBlockersForTask(req.db, ctx.task.id, { onlyOpen })
  return res.json({ ok: true, blockers: list })
})
router.post('/tasks/:taskId/resolve-blocker-input', async (req, res) => {
  const ctx = await loadTaskAndAuthorise(req, res, req.params.taskId)
  if (!ctx) return
  try {
    const directive = await resolveBlocker(req.db, {
      taskId: ctx.task.id,
      profileId: ctx.task.profile_id,
      userId: req.user?.id || null,
      portalUrl: ctx.task.portal_url || ctx.task.application_url || null,
      classification: { automation_type: ctx.task.automation_type },
    }, req.body || {})
    return res.json({ ok: true, directive })
  } catch (err) {
    return res.status(400).json({ error: 'resolve_failed', detail: err?.message })
  }
})

export default router
