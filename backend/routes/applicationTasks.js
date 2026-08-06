/**
 * /api/application-tasks/*
 *
 * Yana application-task surface. Uses the existing auth + profile-scoping
 * pattern (requireAuthenticatedUser + getAccessibleProfileIds). All
 * routes verify the task belongs to a profile the user can access before
 * mutating anything.
 *
 * Endpoints:
 *   GET    /api/application-tasks                       — list tasks for my accessible profiles
 *   GET    /api/application-tasks/:taskId               — fetch a single task with events + missing info
 *   POST   /api/application-tasks                       — create or fetch a task for (profile, opportunity)
 *   POST   /api/application-tasks/:taskId/hamilton/start    � start Hamilton on this task
 *   POST   /api/application-tasks/:taskId/hamilton/continue � continue (e.g. after user supplied info)
 *   POST   /api/application-tasks/:taskId/missing-info  — supply missing info (resolves items)
 *   POST   /api/application-tasks/:taskId/approve-submit — opt-in to auto-submit
 *   POST   /api/application-tasks/:taskId/cancel        — cancel a task
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuthenticatedUser, getAuthUserId, getAccessibleProfileIds } from '../utils/accessControl.js'
import {
  ensureApplicationTask,
  getApplicationTask,
  listApplicationTasks,
  updateApplicationTask,
  cancelApplicationTask,
  appendTaskEvent,
  listMissingInfo,
  resolveMissingInfoItem,
  resumeTaskAfterMissingInfo,
  listTaskEvents,
  TASK_TERMINAL_STATUSES,
} from '../services/hamilton/applicationTaskStore.js'
import { automateSingleSource } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { createLogger } from '../utils/logger.js'
import { revokeTargetAuthorizations } from '../services/hamilton/hamiltonAuthorizationStore.js'
import { cancelActiveHamiltonTaskRun } from '../services/hamilton/hamiltonRunCancellation.js'
import { readAuthorizations } from '../services/hamilton/hamiltonPreflight.js'

const log = createLogger('route:application-tasks')

const router = express.Router()

const SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES = new Set([
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
])

const hamiltonRunLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 60_000 },
})

async function resolveAccessibleProfileIds(req, user) {
  const accessible = await getAccessibleProfileIds(req.db, user)
  return accessible // null = admin/global access
}

async function userMayAccessTask(req, user, task) {
  if (!task) return false
  if (req.ctx?.isAdmin === true) return true
  const accessible = await resolveAccessibleProfileIds(req, user)
  if (accessible === null) return true
  return accessible.has(String(task.profile_id))
}

/**
 * Re-enter the canonical Hamilton orchestrator from an existing task without
 * minting a second source identity or losing its pipeline-stage hint.
 *
 * Deliberately excludes all submit flags. Start/Continue are execution
 * requests, not submission-authority grants; the orchestrator resolves any
 * stored, versioned authority itself.
 */
export function sourceForHamiltonTask(task = {}) {
  return {
    opportunity_id: task.opportunity_id || null,
    grant_id: task.grant_id || null,
    task_id: task.id || null,
    current_stage: task.current_pipeline_stage || task.selected_from_stage || null,
    kind: 'application_task',
  }
}

async function runCanonicalHamiltonTask(req, user, task) {
  const result = await automateSingleSource(req.db, {
    profileId: task.profile_id,
    userId: getAuthUserId(user),
    source: sourceForHamiltonTask(task),
  })
  return result?.ok === undefined ? { ok: true, ...result } : result
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const status = req.query.status ? String(req.query.status) : null
  const profileIdParam = req.query.profile_id || req.query.profileId || null
  try {
    let tasks
    if (req.ctx?.isAdmin === true && profileIdParam) {
      tasks = await listApplicationTasks(req.db, { profileId: String(profileIdParam), status, limit: 200 })
    } else if (req.ctx?.isAdmin === true) {
      tasks = await listApplicationTasks(req.db, { status, limit: 200 })
    } else {
      const accessible = await resolveAccessibleProfileIds(req, user)
      if (!accessible || accessible.size === 0) return res.json({ ok: true, tasks: [] })
      const all = []
      for (const profileId of accessible) {
        const subset = await listApplicationTasks(req.db, { profileId, status, limit: 100 })
        all.push(...subset)
      }
      tasks = all
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 200)
    }
    return res.json({ ok: true, tasks })
  } catch (err) {
    log.error('list tasks failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'application_tasks_list_failed' })
  }
})

router.get('/:taskId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })
    if (task.submission_proof?.source === 'owner_attested_manual_receipt') {
      return res.status(409).json({
        error: 'manual_submission_receipt_active',
        message: 'Revoke the active portal receipt before cancelling this submitted task.',
      })
    }
    const [events, missingInfo] = await Promise.all([
      listTaskEvents(req.db, taskId),
      listMissingInfo(req.db, taskId),
    ])
    return res.json({ ok: true, task, events, missing_info: missingInfo })
  } catch (err) {
    log.error('get task failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'application_tasks_get_failed' })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const body = req.body || {}
  const profileId = String(body.profile_id || body.profileId || '')
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })

  if (req.ctx?.isAdmin !== true) {
    const accessible = await resolveAccessibleProfileIds(req, user)
    if (accessible !== null && !accessible.has(profileId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }
  if (!body.opportunity_id && !body.grant_id) {
    return res.status(400).json({ error: 'opportunity_id or grant_id required' })
  }
  // The referenced source must actually EXIST (2026-08-03): a task whose ids
  // resolve to nothing renders as a permanent "Untitled application" card.
  // A lookup that ERRORS is treated as unverifiable (allow) — only a lookup
  // that succeeds and finds nothing refuses.
  try {
    let resolves = false
    if (body.opportunity_id) {
      try {
        resolves = Boolean(await req.db.prepare('SELECT id FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(body.opportunity_id)))
      } catch { resolves = true }
    }
    if (!resolves && body.grant_id) {
      try {
        resolves = Boolean(await req.db.prepare('SELECT id FROM grants WHERE id = ? LIMIT 1').get(String(body.grant_id)))
      } catch { resolves = true }
    }
    if (!resolves) {
      return res.status(422).json({ ok: false, error: 'unresolvable_funding_source', detail: 'Neither opportunity_id nor grant_id resolves to an existing funding source.' })
    }
    // Funding-source policy gate (2026-08-04) — the same rule the Hamilton
    // orchestrator applies. This raw create was the ONE writer with no gate.
    // A pointer research lead is refused with the owner handoff instructions
    // so the caller can surface them instead of minting a task that can only
    // die silently; a policy lookup ERROR stays fail-open (allow), matching
    // the existence check's posture above.
    try {
      const { assessHamiltonFundingSource } = await import('../services/hamilton/hamiltonFundingSourcePolicy.js')
      let opportunityRow = null
      if (body.opportunity_id) {
        try {
          opportunityRow = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(body.opportunity_id))
        } catch { opportunityRow = null }
      }
      let grantRow = null
      if (body.grant_id) {
        try {
          grantRow = await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(body.grant_id))
        } catch { grantRow = null }
      }
      const assessment = await assessHamiltonFundingSource(req.db, {
        profileId,
        opportunity: opportunityRow,
        grant: grantRow,
      })
      if (!assessment.ok && assessment.code === 'pointer_research_lead') {
        return res.status(422).json({
          ok: false,
          error: 'pointer_research_lead',
          handoff: assessment.handoff,
          detail: assessment.message,
        })
      }
      if (!assessment.ok && assessment.code === 'funding_source_profile_rejected') {
        return res.status(422).json({ ok: false, error: assessment.code, detail: assessment.message })
      }
    } catch (policyErr) {
      log.warn('task-create policy check unavailable (fail-open)', { error: policyErr?.message })
    }
    const task = await ensureApplicationTask(req.db, {
      profileId,
      userId: getAuthUserId(user),
      opportunityId: body.opportunity_id || null,
      grantId: body.grant_id || null,
      portalId: body.portal_id || null,
      initialStatus: 'queued',
    })
    return res.json({ ok: true, task })
  } catch (err) {
    log.error('create task failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || 'application_tasks_create_failed' })
  }
})

// Per-task Hamilton handlers. /yana/* aliases preserved for any in-flight
// clients written before the rename; both paths execute the same code.
async function handleHamiltonStart(req, res) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })

    const result = await runCanonicalHamiltonTask(req, user, task)
    return res.json(result)
  } catch (err) {
    log.error('hamilton start failed', { error: err?.message, taskId })
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'hamilton_start_failed' })
  }
}

async function handleHamiltonContinue(req, res) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })
    if (TASK_TERMINAL_STATUSES.includes(task.status)) {
      return res.status(400).json({ error: 'task_in_terminal_state', status: task.status })
    }
    // Never forward req.body options here. In particular, a client-provided
    // allow_auto_submit value must not become submission authority on resume.
    const result = await runCanonicalHamiltonTask(req, user, task)
    return res.json(result)
  } catch (err) {
    log.error('hamilton continue failed', { error: err?.message, taskId })
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'hamilton_continue_failed' })
  }
}

router.post('/:taskId/hamilton/start',    hamiltonRunLimiter, handleHamiltonStart)
router.post('/:taskId/hamilton/continue', hamiltonRunLimiter, handleHamiltonContinue)
// Backwards-compatible aliases.
router.post('/:taskId/yana/start',        hamiltonRunLimiter, handleHamiltonStart)
router.post('/:taskId/yana/continue',     hamiltonRunLimiter, handleHamiltonContinue)

router.post('/:taskId/missing-info', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (items.length === 0) return res.status(400).json({ error: 'items array required' })
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })

    let resolved = 0
    for (const item of items) {
      if (!item || !item.kind || !item.key) continue
      const ok = await resolveMissingInfoItem(req.db, taskId, {
        kind: item.kind,
        key: item.key,
        value: item.value ?? null,
        resolvedBy: getAuthUserId(user),
      })
      if (ok) resolved += 1
    }
    await appendTaskEvent(req.db, {
      taskId,
      eventType: 'unblocked',
      message: `User supplied ${resolved} missing item${resolved === 1 ? '' : 's'}.`,
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
      details: { resolved },
    })
    const remaining = await listMissingInfo(req.db, taskId, { includeResolved: false })
    // Auto-resume: if every flagged item is now supplied and the task was
    // waiting on the user, re-queue it so Hamilton continues to completion on
    // her own — no manual relaunch. (The login backup plan does the same for
    // auth blockers.)
    const resume = await resumeTaskAfterMissingInfo(req.db, taskId, {
      resolvedCount: resolved, remainingCount: remaining.length,
    })
    if (resume.resumed) {
      await appendTaskEvent(req.db, {
        taskId,
        eventType: 'unblocked',
        status: 'ready',
        step: 'auto_resume',
        message: 'All flagged info supplied — task re-queued; Hamilton will resume automatically.',
        actorUserId: getAuthUserId(user),
        actorRole: 'agent',
        details: { auto_resumed: true },
      })
    }
    const updated = await getApplicationTask(req.db, taskId)
    return res.json({
      ok: true,
      task: updated,
      remaining_missing_info: remaining,
      resolved_count: resolved,
      auto_resumed: Boolean(resume.resumed),
    })
  } catch (err) {
    log.error('missing-info failed', { error: err?.message, taskId })
    return res.status(500).json({ ok: false, error: err?.message || 'missing_info_failed' })
  }
})

router.post('/:taskId/approve-submit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  const enable = req.body?.enable !== false
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })
    if (enable && SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES.has(task.status)) {
      return res.status(409).json({
        error: 'submission_verification_required',
        message: 'Auto-submit cannot be re-enabled while an external submission attempt is unresolved. Check the funder portal and reconcile the confirmation evidence first.',
      })
    }
    const warning = !enable && SUBMISSION_MAY_BE_IN_FLIGHT_STATUSES.has(task.status)
      ? {
          code: 'submission_action_may_be_in_progress',
          message: 'Future auto-submit authority was revoked, but a portal action may already be in progress or awaiting verification. This does not stop or undo an external action; verify the portal before retrying.',
        }
      : null
    if (enable) {
      const authorization = await readAuthorizations(req.db, {
        profileId: task.profile_id,
        fundingSourceId: task.opportunity_id || task.grant_id || null,
        taskId,
      })
      if (!authorization.submit_applications || authorization.require_human_review) {
        return res.status(409).json({
          error: authorization.require_human_review ? 'human_review_required' : 'submit_authorization_required',
          message: authorization.require_human_review
            ? 'Final human review is required for this application. Change the versioned authorization before enabling auto-submit.'
            : 'Authorize submit_applications for this application before enabling auto-submit.',
        })
      }
    }
    await updateApplicationTask(req.db, taskId, {
      autoSubmitEnabled: enable,
      allowAutoSubmit: enable,
    })
    if (!enable) {
      await revokeTargetAuthorizations(req.db, {
        profileId: task.profile_id,
        fundingSourceId: task.opportunity_id || task.grant_id || null,
        taskId,
        authorizationType: 'submit_applications',
        reason: 'task_auto_submit_disabled',
      })
    }
    await appendTaskEvent(req.db, {
      taskId,
      eventType: 'note',
      message: enable
        ? 'User approved auto-submit for this task.'
        : warning?.message || 'User revoked auto-submit for this task.',
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
      details: {
        auto_submit_enabled: enable,
        allow_auto_submit: enable,
        warning_code: warning?.code || null,
      },
    })
    return res.json({
      ok: true,
      task: await getApplicationTask(req.db, taskId),
      ...(warning ? { warning } : {}),
    })
  } catch (err) {
    log.error('approve-submit failed', { error: err?.message, taskId })
    return res.status(500).json({ ok: false, error: err?.message || 'approve_submit_failed' })
  }
})

router.post('/:taskId/cancel', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })
    cancelActiveHamiltonTaskRun(taskId, req.body?.reason || 'cancelled by user')
    const updated = await cancelApplicationTask(req.db, taskId, {
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
      reason: req.body?.reason || 'cancelled by user',
    })
    return res.json({ ok: true, task: updated })
  } catch (err) {
    log.error('cancel failed', { error: err?.message, taskId })
    if (err?.code === 'manual_submission_receipt_active') {
      return res.status(409).json({ ok: false, error: err.code, message: err.message })
    }
    return res.status(500).json({ ok: false, error: err?.message || 'cancel_failed' })
  }
})

export default router
