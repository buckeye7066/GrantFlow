/**
 * /api/yana/automation/*
 *
 * Top-level "Automate with Yana" surface. Adds the bulk select-many
 * entry point and channel-specific submission acks (mark-mailed,
 * mark-emailed, mark-faxed) on top of the existing
 * /api/application-tasks endpoints.
 *
 * Endpoints:
 *   POST   /api/yana/automation/start                       — bulk start automation for selected sources
 *   POST   /api/yana/automation/tasks/:taskId/regenerate    — regenerate the packet (e.g. after profile edits)
 *   POST   /api/yana/automation/tasks/:taskId/mark-mailed   — record physical mail submission
 *   POST   /api/yana/automation/tasks/:taskId/mark-emailed  — record email submission
 *   POST   /api/yana/automation/tasks/:taskId/mark-faxed    — record fax submission
 *   POST   /api/yana/automation/tasks/:taskId/approve       — explicit user approval to submit
 *   GET    /api/yana/automation/tasks                       — list automation tasks scoped to caller
 *   GET    /api/yana/automation/tasks/:taskId               — fetch one with classification + outputs
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
} from '../services/yana/applicationTaskStore.js'
import {
  automateSelected,
  automateSingleSource,
} from '../services/yana/yanaAutomationOrchestrator.js'
import { generateAndSavePacket } from '../services/yana/yanaApplicationPacketGenerator.js'
import { emitYanaNotificationToProfileAndAdmins } from '../services/yana/yanaNotifications.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:yana-automation')

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
    await emitYanaNotificationToProfileAndAdmins(req.db, {
      profileId: ctx.task.profile_id,
      profileUserId: ctx.task.user_id,
      type: 'yana_submitted',
      title: `Yana logged a ${channel.toUpperCase()} submission`,
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

export default router
