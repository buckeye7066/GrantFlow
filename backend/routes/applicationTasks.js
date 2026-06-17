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
 *   POST   /api/application-tasks/:taskId/yana/start    — start Yana on this task
 *   POST   /api/application-tasks/:taskId/yana/continue — continue (e.g. after user supplied info)
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
  listTaskEvents,
  TASK_TERMINAL_STATUSES,
} from '../services/yana/applicationTaskStore.js'
import {
  startYanaForOpportunity,
  continueYanaTask,
} from '../services/yanaApplicationAgent.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:application-tasks')

const router = express.Router()

const yanaRunLimiter = rateLimit({
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
  if (user.role === 'admin') return true
  const accessible = await resolveAccessibleProfileIds(req, user)
  if (accessible === null) return true
  return accessible.has(String(task.profile_id))
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const status = req.query.status ? String(req.query.status) : null
  const profileIdParam = req.query.profile_id || req.query.profileId || null
  try {
    let tasks
    if (user.role === 'admin' && profileIdParam) {
      tasks = await listApplicationTasks(req.db, { profileId: String(profileIdParam), status, limit: 200 })
    } else if (user.role === 'admin') {
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

  if (user.role !== 'admin') {
    const accessible = await resolveAccessibleProfileIds(req, user)
    if (accessible !== null && !accessible.has(profileId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }
  if (!body.opportunity_id && !body.grant_id) {
    return res.status(400).json({ error: 'opportunity_id or grant_id required' })
  }
  try {
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

router.post('/:taskId/yana/start', yanaRunLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  try {
    const task = await getApplicationTask(req.db, taskId)
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!(await userMayAccessTask(req, user, task))) return res.status(403).json({ error: 'Forbidden' })

    const result = await startYanaForOpportunity(req.db, {
      profileId: task.profile_id,
      userId: getAuthUserId(user),
      opportunityId: task.opportunity_id,
      grantId: task.grant_id,
      mode: 'execute',
      trigger: req.body?.trigger || 'manual',
    })
    return res.json(result)
  } catch (err) {
    log.error('yana start failed', { error: err?.message, taskId })
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'yana_start_failed' })
  }
})

router.post('/:taskId/yana/continue', yanaRunLimiter, async (req, res) => {
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
    const result = await continueYanaTask(req.db, {
      taskId,
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
    })
    return res.json(result)
  } catch (err) {
    log.error('yana continue failed', { error: err?.message, taskId })
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'yana_continue_failed' })
  }
})

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
    const updated = await getApplicationTask(req.db, taskId)
    const remaining = await listMissingInfo(req.db, taskId, { includeResolved: false })
    return res.json({ ok: true, task: updated, remaining_missing_info: remaining, resolved_count: resolved })
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
    await updateApplicationTask(req.db, taskId, { autoSubmitEnabled: enable })
    await appendTaskEvent(req.db, {
      taskId,
      eventType: 'note',
      message: enable
        ? 'User approved auto-submit for this task.'
        : 'User revoked auto-submit for this task.',
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
      details: { auto_submit_enabled: enable },
    })
    return res.json({ ok: true, task: await getApplicationTask(req.db, taskId) })
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
    const updated = await cancelApplicationTask(req.db, taskId, {
      actorUserId: getAuthUserId(user),
      actorRole: user.role || null,
      reason: req.body?.reason || 'cancelled by user',
    })
    return res.json({ ok: true, task: updated })
  } catch (err) {
    log.error('cancel failed', { error: err?.message, taskId })
    return res.status(500).json({ ok: false, error: err?.message || 'cancel_failed' })
  }
})

export default router
