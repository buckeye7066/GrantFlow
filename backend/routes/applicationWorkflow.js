/**
 * applicationWorkflow.js — REST routes for the Phase 7 workflow service.
 *
 * Mission rule (Phase 7): every discovered opportunity can become a saved
 * item, application plan, document checklist, deadline tracker, and
 * Anya-guided workflow. This route file exposes the canonical
 * `applicationWorkflow.js` service so the frontend (and Anya) have a
 * stable HTTP contract:
 *
 *   POST   /api/application-workflow/from-opportunity
 *           { profile_id, opportunity }  → { id, created, plan }
 *
 *   GET    /api/application-workflow/:applicationId
 *           → { application, steps, documents, deadlines, submissions }
 *
 *   POST   /api/application-workflow/:applicationId/steps
 *           { title, description?, due_at? } → { id }
 *
 *   PATCH  /api/application-workflow/steps/:stepId/complete
 *           → { ok: true }
 *
 *   POST   /api/application-workflow/:applicationId/documents
 *           { filename, document_type?, storage_url?, size_bytes?, step_id? }
 *
 *   POST   /api/application-workflow/:applicationId/submissions
 *           { event_type, notes?, outcome? }
 *
 *   PATCH  /api/application-workflow/:applicationId/status
 *           { status }  → { ok: true }
 *
 * Every write checks the calling user owns the underlying profile so we
 * never mix workflows across accounts.
 */

import express from 'express'
import { ensureProfileAccess, requireAuthenticatedUserMiddleware, getAuthUserId } from '../utils/accessControl.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { createLogger } from '../utils/logger.js'
import {
  APPLICATION_STATES,
  generateActionPlan,
  createApplicationFromOpportunity,
  addApplicationStep,
  completeApplicationStep,
  addApplicationDocument,
  recordSubmissionEvent,
  setApplicationStatus,
} from '../services/applicationWorkflow.js'

const router = express.Router()
const routeLogger = createLogger('route:applicationWorkflow')

router.use(requireAuthenticatedUserMiddleware)

async function loadApplication(req, res, applicationId) {
  if (!applicationId) {
    res.status(400).json({ error: 'applicationId required' })
    return null
  }
  const row = await req.db
    .prepare('SELECT id, profile_id, user_id, status FROM grant_applications WHERE id = ?')
    .get(String(applicationId))
  if (!row) {
    res.status(404).json({ error: 'Application not found' })
    return null
  }
  if (row.profile_id) {
    const ok = await ensureProfileAccess(req, res, String(row.profile_id))
    if (!ok) return null
  } else if (req.ctx?.isAdmin !== true) {
    // Fail CLOSED on an orphaned (profile_id IS NULL) application: previously
    // the access check was skipped entirely for such rows, letting any
    // authenticated user read/mutate another tenant's orphan application.
    // Only admins (who legitimately span tenants and own orphan cleanup) may
    // touch a NULL-profile row. Mirrors the fail-closed siblings in
    // applications.js / vnextApplications.js / applicationTasks.js.
    res.status(403).json({ error: 'Not authorized to access this application' })
    return null
  }
  return row
}

// POST /api/application-workflow/from-opportunity
// Persist an opportunity into the workflow tables (application + steps +
// documents checklist + deadlines). Idempotent on (profile_id, opportunity_id).
router.post('/from-opportunity', async (req, res) => {
  try {
    const userId = getAuthUserId(req?.user ?? req?.ctx)
    const { profile_id: profileId, pipeline_grant_id: pipelineGrantId, opportunity } = req.body ?? {}
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    if (!opportunity?.id) {
      return res.status(400).json({ error: 'opportunity.id required' })
    }
    const ok = await ensureProfileAccess(req, res, String(profileId))
    if (!ok) return
    const profileContext = await loadProfileContext(req.db, String(profileId)).catch(() => ({}))
    const result = await createApplicationFromOpportunity(req.db, {
      profileId: String(profileId),
      userId,
      opportunity,
      pipelineGrantId: pipelineGrantId ? String(pipelineGrantId) : null,
      profileContext,
    })
    routeLogger.info(`[applicationWorkflow] from-opportunity profile=${profileId} → application=${result.id} created=${result.created}`)
    return res.status(result.created ? 201 : 200).json(result)
  } catch (err) {
    routeLogger.error('from-opportunity failed', { err: err?.message })
    return res.status(Number(err?.status) || 500).json({ error: err?.code || err?.message || String(err), message: err?.message })
  }
})

// POST /api/application-workflow/preview
// Pure planner — does not persist. Useful for showing a user what the
// plan will look like before they hit "Save" / "Start application".
router.post('/preview', async (req, res) => {
  try {
    const { profile_id: profileId, opportunity } = req.body ?? {}
    if (!opportunity || !opportunity.title) {
      return res.status(400).json({ error: 'opportunity.title required' })
    }
    let profileContext = {}
    if (profileId) {
      const ok = await ensureProfileAccess(req, res, String(profileId))
      if (!ok) return
      profileContext = await loadProfileContext(req.db, String(profileId)).catch(() => ({}))
    }
    const plan = generateActionPlan(opportunity, profileContext)
    return res.json({ plan })
  } catch (err) {
    routeLogger.error('preview failed', { err: err?.message })
    return res.status(500).json({ error: err?.message ?? String(err) })
  }
})

// GET /api/application-workflow/:applicationId
router.get('/:applicationId', async (req, res) => {
  try {
    const app = await loadApplication(req, res, req.params.applicationId)
    if (!app) return
    const id = String(req.params.applicationId)
    const [steps, documents, deadlines, submissions] = await Promise.all([
      req.db.prepare('SELECT * FROM application_steps WHERE application_id = ? ORDER BY step_order ASC').all(id),
      req.db.prepare('SELECT * FROM application_documents WHERE application_id = ? ORDER BY uploaded_at ASC').all(id),
      req.db.prepare('SELECT * FROM deadline_events WHERE application_id = ? ORDER BY due_at ASC').all(id),
      req.db.prepare('SELECT * FROM submission_events WHERE application_id = ? ORDER BY occurred_at ASC').all(id),
    ])
    return res.json({
      application: app,
      steps: Array.isArray(steps) ? steps : [],
      documents: Array.isArray(documents) ? documents : [],
      deadlines: Array.isArray(deadlines) ? deadlines : [],
      submissions: Array.isArray(submissions) ? submissions : [],
      allowed_statuses: APPLICATION_STATES,
    })
  } catch (err) {
    routeLogger.error('get application failed', { err: err?.message })
    return res.status(500).json({ error: err?.message ?? String(err) })
  }
})

// POST /api/application-workflow/:applicationId/steps
router.post('/:applicationId/steps', async (req, res) => {
  try {
    const app = await loadApplication(req, res, req.params.applicationId)
    if (!app) return
    const { title, description, due_at: dueAt } = req.body ?? {}
    if (!title) return res.status(400).json({ error: 'title required' })
    const stepId = await addApplicationStep(req.db, String(req.params.applicationId), {
      title: String(title).slice(0, 240),
      description: description ?? null,
      dueAt: dueAt ?? null,
    })
    return res.status(201).json({ id: stepId })
  } catch (err) {
    return res.status(Number(err?.status) || 500).json({ error: err?.code || err?.message || String(err), message: err?.message })
  }
})

// PATCH /api/application-workflow/steps/:stepId/complete
router.patch('/steps/:stepId/complete', async (req, res) => {
  try {
    if (!req.params.stepId) return res.status(400).json({ error: 'stepId required' })
    // Confirm the step belongs to an application this user owns.
    const row = await req.db
      .prepare(
        `SELECT s.id, s.application_id, a.profile_id
           FROM application_steps s
           JOIN grant_applications a ON a.id = s.application_id
          WHERE s.id = ?`,
      )
      .get(String(req.params.stepId))
    if (!row) return res.status(404).json({ error: 'Step not found' })
    if (row.profile_id) {
      const ok = await ensureProfileAccess(req, res, String(row.profile_id))
      if (!ok) return
    } else if (req.ctx?.isAdmin !== true) {
      // Fail closed on an orphaned (NULL profile_id) application step — see
      // loadApplication() above for rationale.
      return res.status(403).json({ error: 'Not authorized to modify this step' })
    }
    await completeApplicationStep(req.db, String(req.params.stepId))
    return res.json({ ok: true })
  } catch (err) {
    return res.status(Number(err?.status) || 500).json({ error: err?.code || err?.message || String(err), message: err?.message })
  }
})

// POST /api/application-workflow/:applicationId/documents
router.post('/:applicationId/documents', async (req, res) => {
  try {
    const app = await loadApplication(req, res, req.params.applicationId)
    if (!app) return
    const { filename, document_type: documentType, storage_url: storageUrl, size_bytes: sizeBytes, step_id: stepId } = req.body ?? {}
    if (!filename) return res.status(400).json({ error: 'filename required' })
    const userId = getAuthUserId(req?.user ?? req?.ctx)
    const id = await addApplicationDocument(req.db, String(req.params.applicationId), {
      filename: String(filename).slice(0, 240),
      documentType: documentType ?? null,
      storageUrl: storageUrl ?? null,
      sizeBytes: Number.isFinite(Number(sizeBytes)) ? Number(sizeBytes) : null,
      stepId: stepId ?? null,
      uploadedBy: userId ?? null,
    })
    return res.status(201).json({ id })
  } catch (err) {
    return res.status(Number(err?.status) || 500).json({ error: err?.code || err?.message || String(err), message: err?.message })
  }
})

// POST /api/application-workflow/:applicationId/submissions
router.post('/:applicationId/submissions', async (req, res) => {
  try {
    const app = await loadApplication(req, res, req.params.applicationId)
    if (!app) return
    const { event_type: eventType, notes, outcome } = req.body ?? {}
    if (!eventType) return res.status(400).json({ error: 'event_type required' })
    const userId = getAuthUserId(req?.user ?? req?.ctx)
    const id = await recordSubmissionEvent(req.db, String(req.params.applicationId), {
      eventType: String(eventType).slice(0, 64),
      notes: notes ?? null,
      outcome: outcome ?? null,
      recordedBy: userId ?? null,
    })
    return res.status(201).json({ id })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? String(err) })
  }
})

// PATCH /api/application-workflow/:applicationId/status
router.patch('/:applicationId/status', async (req, res) => {
  try {
    const app = await loadApplication(req, res, req.params.applicationId)
    if (!app) return
    const { status } = req.body ?? {}
    if (!status) return res.status(400).json({ error: 'status required' })
    if (!APPLICATION_STATES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${APPLICATION_STATES.join(', ')}` })
    }
    await setApplicationStatus(req.db, String(req.params.applicationId), status)
    return res.json({ ok: true, status })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? String(err) })
  }
})

export default router
