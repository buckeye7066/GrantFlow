/**
 * yanaApplications.js
 *
 * Real-browser-automation endpoints for Yana. Mounted under
 *   /api/application-tasks/:taskId/yana/browser/*
 * and
 *   /api/application-tasks/:taskId/yana/audit
 *
 * All routes:
 *   - Require an authenticated user.
 *   - Enforce that the task belongs to a profile the user can access.
 *   - Are rate-limited.
 *   - Refuse to do anything when YANA_ENABLE_BROWSER_AUTOMATION is off.
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuthenticatedUser, getAccessibleProfileIds } from '../utils/accessControl.js'
import {
  getApplicationTask,
  listTaskEvents,
} from '../services/yana/applicationTaskStore.js'
import {
  startBrowserSession,
  markUserReadyAndContinue,
  saveDraft,
  approveAndSubmit,
  cancelBrowserSession,
  getStatus,
} from '../services/yana/yanaPortalAutomation.js'
import {
  isBrowserAutomationEnabled,
  isAutoSubmitEnabledGlobally,
} from '../services/yana/browserSessionService.js'
import { listSessionsForTask } from '../services/yana/browserSessionStore.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:yana-browser')

const router = express.Router()

const browserActionLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 60_000 },
})

async function resolveAccess(req, user, taskId) {
  const task = await getApplicationTask(req.db, taskId)
  if (!task) return { task: null, allowed: false }
  if (user.role === 'admin') return { task, allowed: true }
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return { task, allowed: true }
  return { task, allowed: accessible.has(String(task.profile_id)) }
}

function refuseIfBrowserDisabled(res) {
  if (!isBrowserAutomationEnabled()) {
    res.status(412).json({
      error: 'browser_automation_disabled',
      message: 'Set YANA_ENABLE_BROWSER_AUTOMATION=true to enable Yana browser automation.',
    })
    return true
  }
  return false
}

router.use(browserActionLimiter)

router.get('/:taskId/yana/browser/status', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await getStatus(req.db, { taskId, profileId: task.profile_id })
    return res.json({
      ok: true,
      enabled: isBrowserAutomationEnabled(),
      auto_submit_enabled_globally: isAutoSubmitEnabledGlobally(),
      session,
    })
  } catch (err) {
    log.error?.(`status failed: ${err?.message || err}`)
    return res.status(500).json({ error: 'status_failed', message: err?.message || String(err) })
  }
})

router.get('/:taskId/yana/audit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const [events, sessions] = await Promise.all([
      listTaskEvents(req.db, taskId, { limit: 200 }),
      listSessionsForTask(req.db, taskId, { profileId: task.profile_id, limit: 50 }),
    ])
    return res.json({ ok: true, events, sessions })
  } catch (err) {
    log.error?.(`audit failed: ${err?.message || err}`)
    return res.status(500).json({ error: 'audit_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/start', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await startBrowserSession(req.db, {
      taskId,
      profileId: task.profile_id,
      userId: user.id,
      headlessOverride: typeof req.body?.headless === 'boolean' ? req.body.headless : null,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    log.error?.(`start failed: ${err?.message || err}`)
    return res.status(err?.status || 500).json({ error: 'start_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/resume', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    // Resume = relaunch into the same storage_state and immediately
    // try to advance.
    await startBrowserSession(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
    })
    const session = await markUserReadyAndContinue(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'resume_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/user-ready', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await markUserReadyAndContinue(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'user_ready_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/fill', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    // /fill is the same code path as user-ready; it's exposed
    // separately so the UI can re-run filling after the user supplies
    // missing info via /api/application-tasks/:id/missing-info.
    const session = await markUserReadyAndContinue(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'fill_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/save-draft', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await saveDraft(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'save_draft_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/approve-submit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (refuseIfBrowserDisabled(res)) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await approveAndSubmit(req.db, {
      taskId,
      profileId: task.profile_id,
      userId: user.id,
      actorRole: user.role || 'user',
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'submit_failed', message: err?.message || String(err) })
  }
})

router.post('/:taskId/yana/browser/cancel', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { taskId } = req.params
  const { task, allowed } = await resolveAccess(req, user, taskId)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  if (!allowed) return res.status(403).json({ error: 'forbidden' })
  try {
    const session = await cancelBrowserSession(req.db, {
      taskId, profileId: task.profile_id, userId: user.id,
      reason: req.body?.reason || null,
    })
    return res.json({ ok: true, session })
  } catch (err) {
    return res.status(err?.status || 500).json({ error: 'cancel_failed', message: err?.message || String(err) })
  }
})

export default router
