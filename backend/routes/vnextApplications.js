import express from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import {
  requireAuthenticatedUser,
  ensureProfileAccess,
} from '../utils/accessControl.js'
import { isFeatureEnabled } from '../services/featureFlagService.js'
import { safeJsonParse, jsonForDb, sqlNowLiteral } from '../vnext/vnextUtils.js'
import { VNEXT_STATES, normalizeVNextState } from '../vnext/constants.js'
import { attemptTransition } from '../vnext/stateMachine.js'
import { computeMissingRequirements } from '../vnext/missingnessService.js'
import { scoreApplication } from '../vnext/scoringService.js'
import { writeAuditEvent } from '../vnext/auditEventsService.js'
import { standardRateLimiter, mutationRateLimiter } from '../middleware/rateLimiting.js'
import { portalUrlFunderPlausibility } from '../config/urlRules.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:vnextApplications')

const router = express.Router()

function vnextEnabled(req) {
  const env = String(process.env.SHOULDERS_VNEXT || '').trim().toLowerCase() === 'true'
  if (env) return true
  try {
    const ctx = req.ctx || {}
    return isFeatureEnabled(req.db, 'shoulders.vnext', {
      userId: ctx.userId ?? null,
      profileId: ctx.activeProfileId ?? null,
      isAdmin: Boolean(ctx.isAdmin),
    })
  } catch {
    return false
  }
}

function errorResponse(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, details: details ?? undefined } })
}

function requireVNext(req, res) {
  if (!vnextEnabled(req)) {
    errorResponse(res, 404, 'FEATURE_DISABLED', 'vNext Shoulders backbone is disabled', {
      flag: 'shoulders.vnext',
      env: 'SHOULDERS_VNEXT',
    })
    return false
  }
  return true
}

const CreateSchema = z.object({
  profile_id: z.string().min(1),
  opportunity_id: z.string().min(1),
})

const TransitionSchema = z.object({
  targetState: z.string().min(1),
})

function normalizeAppRow(db, row) {
  if (!row) return null
  return {
    ...row,
    score_breakdown: safeJsonParse(row.score_breakdown, null),
    missing_requirements: safeJsonParse(row.missing_requirements, null),
  }
}

router.get('/', standardRateLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireVNext(req, res)) return

  const headerProfileId = typeof req.headers['x-profile-id'] === 'string' ? req.headers['x-profile-id'] : null
  const profileId = (typeof req.query.profile_id === 'string' ? req.query.profile_id : null) || headerProfileId
  if (!profileId) {
    return errorResponse(res, 400, 'PROFILE_ID_REQUIRED', 'profile_id is required to list vNext applications')
  }

  const ok = await ensureProfileAccess(req, res, String(profileId))
  if (!ok) return

  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '200'), 10) || 200, 1), 500)

  const rows = await req.db
    .prepare(
      `
        SELECT *
        FROM vnext_applications
        WHERE profile_id = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `,
    )
    .all(String(profileId), limit)

  return res.json((rows || []).map((r) => normalizeAppRow(req.db, r)))
})

router.post('/', mutationRateLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireVNext(req, res)) return

  const parsed = CreateSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return errorResponse(res, 400, 'INVALID_REQUEST', 'Invalid request body', parsed.error.issues)
  }

  const profileId = String(parsed.data.profile_id)
  const opportunityId = String(parsed.data.opportunity_id)

  const ok = await ensureProfileAccess(req, res, profileId)
  if (!ok) return

  const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunityId)
  if (!opp) return errorResponse(res, 404, 'OPPORTUNITY_NOT_FOUND', 'Opportunity not found')

  const id = crypto.randomUUID()
  const nowExpr = sqlNowLiteral(req.db)
  try {
    // Unique(profile_id, opportunity_id) keeps creation idempotent.
    const insertSql =
      req.db?.dialect === 'postgres'
        ? `
            INSERT INTO vnext_applications (
              id, created_at, updated_at,
              profile_id, opportunity_id,
              stage, state
            ) VALUES (?, ${nowExpr}, ${nowExpr}, ?, ?, ?, ?)
            ON CONFLICT(profile_id, opportunity_id) DO NOTHING
          `
        : `
            INSERT OR IGNORE INTO vnext_applications (
              id, created_at, updated_at,
              profile_id, opportunity_id,
              stage, state
            ) VALUES (?, ${nowExpr}, ${nowExpr}, ?, ?, ?, ?)
          `

    await req.db
      .prepare(insertSql)
      .run(id, profileId, opportunityId, VNEXT_STATES.DISCOVERED, VNEXT_STATES.DISCOVERED)

    // Fetch canonical row (either inserted or existing)
    const row = await req.db
      .prepare('SELECT * FROM vnext_applications WHERE profile_id = ? AND opportunity_id = ? LIMIT 1')
      .get(profileId, opportunityId)
    const app = normalizeAppRow(req.db, row)

    await writeAuditEvent(req.db, {
      actor: { type: req.ctx?.isAdmin === true ? 'system' : 'user', id: req.ctx?.userId ?? user?.userId ?? null },
      entity_type: 'vnext_application',
      entity_id: String(app.id),
      action: 'application.created',
      before: null,
      after: { profile_id: profileId, opportunity_id: opportunityId },
    })

    return res.status(201).json(app)
  } catch (error) {
    return errorResponse(res, 500, 'CREATE_FAILED', error?.message || 'Create failed')
  }
})

router.get('/:id', standardRateLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireVNext(req, res)) return

  const id = String(req.params.id)
  const row = await req.db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(id)
  if (!row) return errorResponse(res, 404, 'NOT_FOUND', 'Application not found')

  const ok = await ensureProfileAccess(req, res, String(row.profile_id))
  if (!ok) return

  return res.json(normalizeAppRow(req.db, row))
})

router.post('/:id/transition', mutationRateLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireVNext(req, res)) return

  const parsed = TransitionSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return errorResponse(res, 400, 'INVALID_REQUEST', 'Invalid request body', parsed.error.issues)
  }

  const id = String(req.params.id)
  const row = await req.db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(id)
  if (!row) return errorResponse(res, 404, 'NOT_FOUND', 'Application not found')

  const ok = await ensureProfileAccess(req, res, String(row.profile_id))
  if (!ok) return

  const targetState = normalizeVNextState(parsed.data.targetState)
  if (!targetState) {
    return errorResponse(res, 400, 'INVALID_TARGET_STATE', 'Invalid targetState')
  }

  const actor = { type: req.ctx?.isAdmin === true ? 'system' : 'user', id: req.ctx?.userId ?? user?.userId ?? null }

  // Always record attempt (even if blocked)
  await writeAuditEvent(req.db, {
    actor,
    entity_type: 'vnext_application',
    entity_id: id,
    action: 'transition.attempted',
    before: { state: row.state, target: targetState },
    after: null,
  })

  const result = await attemptTransition(req.db, id, targetState, actor)
  if (!result.ok) {
    const blockers = result.blockers || []
    return res.status(409).json({
      ok: false,
      error: {
        code: 'TRANSITION_BLOCKED',
        message: 'Transition blocked',
        details: { blockers },
      },
      blockers,
    })
  }

  const updated = await req.db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(id)
  return res.json({ ok: true, state: result.newState, application: normalizeAppRow(req.db, updated) })
})

router.get('/:id/finish-packet', standardRateLimiter, async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!requireVNext(req, res)) return

  const id = String(req.params.id)
  const row = await req.db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(id)
  if (!row) return errorResponse(res, 404, 'NOT_FOUND', 'Application not found')

  const ok = await ensureProfileAccess(req, res, String(row.profile_id))
  if (!ok) return

  // Ensure missingness + scoring are present (idempotent, deterministic)
  const actor = { type: req.ctx?.isAdmin === true ? 'system' : 'user', id: req.ctx?.userId ?? user?.userId ?? null }
  const miss = await computeMissingRequirements(req.db, { applicationId: id, actor })
  if (!miss.ok) {
    return errorResponse(res, 409, miss.error?.code || 'MISSINGNESS_FAILED', miss.error?.message || 'Missingness failed', miss.error)
  }
  const scored = await scoreApplication(req.db, { applicationId: id, actor })
  if (!scored.ok) {
    return errorResponse(res, 500, scored.error?.code || 'SCORING_FAILED', scored.error?.message || 'Scoring failed', scored.error)
  }

  const appRow = await req.db.prepare('SELECT * FROM vnext_applications WHERE id = ?').get(id)
  const app = normalizeAppRow(req.db, appRow)
  const opportunity = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(String(app.opportunity_id))

  const funder =
    opportunity?.funder_id
      ? await req.db.prepare('SELECT * FROM funders WHERE id = ?').get(String(opportunity.funder_id))
      : null

  const remaining_tasks = await req.db
    .prepare(
      `
        SELECT *
        FROM vnext_application_tasks
        WHERE application_id = ?
          AND status != 'done'
        ORDER BY created_at ASC
      `,
    )
    .all(id)

  const doc_bundle = await req.db
    .prepare(
      `
        SELECT id, type, storage_uri, file_url, file_path
        FROM documents
        WHERE profile_id = ?
          AND (vnext_application_id = ? OR vnext_application_id IS NULL)
        ORDER BY created_at DESC
        LIMIT 50
      `,
    )
    .all(String(app.profile_id), id)

  const boundary = {
    type: app.boundary_type || 'none',
    url: app.boundary_url || opportunity?.apply_url || opportunity?.application_url || null,
  }

  const submission_instructions = []
  const mode = String(opportunity?.application_mode || opportunity?.application_method || 'unknown').toLowerCase()
  const applyUrl = String(opportunity?.apply_url || opportunity?.application_url || '').trim()
  // Same screen as applyEngine.resolveVerifiedPortalUrl (the
  // cpcc-for-Cleveland-State class): a tenant-slug portal whose slug the
  // funder's own institution name cannot explain is never named as the target.
  const applyUrlImplausible =
    applyUrl && portalUrlFunderPlausibility(applyUrl, opportunity?.sponsor) === 'implausible'

  if (mode === 'portal' || (applyUrl && /^https?:\/\//i.test(applyUrl))) {
    submission_instructions.push('Submit via portal link (open and complete required portal steps).')
    if (applyUrl && !applyUrlImplausible) submission_instructions.push(`Portal URL: ${applyUrl}`)
    if (applyUrlImplausible) submission_instructions.push('Portal URL: unverified — confirm with funder')
  } else {
    submission_instructions.push('Prepare a finish packet for submission (print + sign + assemble required attachments).')
  }

  return res.json({
    application: app,
    opportunity,
    funder,
    boundary,
    remaining_tasks,
    missing_requirements: app.missing_requirements,
    submission_instructions,
    doc_bundle,
  })
})

export default router

