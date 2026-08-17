import express from 'express'
import crypto from 'crypto'
import {
  requireAuthenticatedUser,
  ensureGrantAccess,
  ensureProfileAccess,
  getAccessibleOrganizationIds,
} from '../utils/accessControl.js'
import {
  auditDraftAgainstStoredRequirements,
  persistDraftRequirementCoverage,
  resolveApplicationIdForGrant,
} from '../services/groundedDrafting.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:applicationDrafts')

const router = express.Router()

async function runDraftWriteTransaction(db, work) {
  if (typeof db?.withTransaction !== 'function') {
    const error = new Error('Draft persistence requires an atomic database transaction')
    error.code = 'DRAFT_TRANSACTION_UNAVAILABLE'
    error.status = 503
    throw error
  }
  return db.withTransaction(work)
}

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

async function prepareGroundingAudit(req, res, {
  grantId,
  draftText,
  targetStatus,
  requirementResponses = [],
  claimEvidence = [],
} = {}) {
  if (!['review', 'final'].includes(String(targetStatus || '').toLowerCase())) return null
  if (!String(draftText || '').trim()) {
    return {
      applicationId: null,
      audit: {
        can_finalize: false,
        blockers: [{ code: 'DRAFT_TEXT_REQUIRED', message: 'Draft text is required before review or finalization.' }],
      },
    }
  }
  const applicationId = await resolveApplicationIdForGrant(req.db, grantId)
  if (!applicationId) {
    return {
      applicationId: null,
      audit: {
        can_finalize: false,
        blockers: [{
          code: 'APPLICATION_LIFECYCLE_REQUIRED',
          message: 'Start an application workflow before reviewing or finalizing this draft.',
        }],
      },
    }
  }
  const applicationScope = await req.db.prepare(
    'SELECT profile_id, pipeline_grant_id FROM grant_applications WHERE id = ? LIMIT 1',
  ).get(applicationId)
  if (!applicationScope || String(applicationScope.pipeline_grant_id || '') !== String(grantId)) {
    const error = new Error('Resolved application does not belong to the authorized grant')
    error.code = 'APPLICATION_GRANT_SCOPE_MISMATCH'
    error.status = 409
    throw error
  }
  if (!(await ensureProfileAccess(req, res, String(applicationScope.profile_id || '')))) {
    return { responseSent: true }
  }
  const result = await auditDraftAgainstStoredRequirements(req.db, {
    applicationId,
    draftText,
    requirementResponses,
    claimEvidence,
  })
  return { applicationId, audit: result.audit }
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const limit = normalizeLimit(req.query.limit, 50)
    const grantId = req.query.grant_id ? String(req.query.grant_id) : null
    const id = req.query.id ? String(req.query.id) : null

    const clauses = []
    const params = []

    if (id) {
      clauses.push('a.id = ?')
      params.push(id)
    }
    if (grantId) {
      clauses.push('a.grant_id = ?')
      params.push(grantId)
    }

    if (!req.ctx?.isAdmin) {
      const allowed = req.ctx?.accessibleOrgIds ?? (await getAccessibleOrganizationIds(req.db, user))
      const allowedList = allowed === null ? null : Array.from(allowed || [])
      if (allowedList && allowedList.length === 0) return res.json([])
      if (allowedList) {
        // Validate allowedList contains only valid org IDs BEFORE staging into query
        if (!allowedList.every(orgId => typeof orgId === 'string' && /^[a-zA-Z0-9_-]+$/.test(orgId))) {
          return res.status(403).json({ error: 'Invalid organization access' })
        }
        const placeholders = allowedList.map(() => '?').join(', ')
        clauses.push(`g.organization_id IN (${placeholders})`)
        params.push(...allowedList)
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT a.*, g.organization_id
          FROM application_drafts a
          INNER JOIN grants g ON g.id = a.grant_id
          ${where}
          ORDER BY a.updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json(rows || [])
  } catch (error) {
    routeLogger.error('[application-drafts] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const row = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(row.grant_id))
    if (!grant) return
    return res.json(row)
  } catch (error) {
    routeLogger.error('[application-drafts] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const data = req.body ?? {}
    const grantId = data.grant_id ? String(data.grant_id) : null
    if (!grantId) return res.status(400).json({ error: 'grant_id required' })
    const grant = await ensureGrantAccess(req, res, grantId)
    if (!grant) return

    const id = data.id ? String(data.id) : crypto.randomUUID()
    const targetStatus = data.status ?? 'draft'
    const grounding = await prepareGroundingAudit(req, res, {
      grantId,
      draftText: data.content ?? '',
      targetStatus,
      requirementResponses: data.requirement_responses || [],
      claimEvidence: data.claim_evidence || [],
    })
    if (grounding?.responseSent) return
    if (targetStatus === 'final' && grounding && !grounding.audit.can_finalize) {
      return res.status(422).json({
        error: 'draft_grounding_failed',
        message: 'Draft cannot be finalized until mandatory requirements and applicant claims are grounded.',
        audit: grounding.audit,
      })
    }

    const row = await runDraftWriteTransaction(req.db, async (tx) => {
      await tx.prepare(
        `
          INSERT INTO application_drafts (
            id, grant_id,
            section_name, section_order,
            prompt, content, ai_suggestions,
            word_limit, word_count,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        id,
        grantId,
        data.section_name ?? null,
        data.section_order ?? null,
        data.prompt ?? null,
        data.content ?? null,
        data.ai_suggestions ?? null,
        data.word_limit ?? null,
        data.word_count ?? null,
        targetStatus,
      )
      if (grounding?.applicationId) {
        await persistDraftRequirementCoverage(tx, {
          applicationId: grounding.applicationId,
          draftId: id,
          audit: grounding.audit,
        })
      }
      return tx.prepare('SELECT * FROM application_drafts WHERE id = ?').get(id)
    })
    return res.status(201).json({ ...row, grounding_audit: grounding?.audit || null })
  } catch (error) {
    routeLogger.error('[application-drafts] create error:', error)
    const status = error?.name === 'ZodError' ? 400 : (Number(error?.status) || 500)
    return res.status(status).json({ error: error?.code || error?.message || String(error), details: error?.issues })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    const data = req.body ?? {}
    const targetStatus = data.status ?? existing.status
    const targetContent = data.content ?? existing.content ?? ''
    const grounding = await prepareGroundingAudit(req, res, {
      grantId: String(existing.grant_id),
      draftText: targetContent,
      targetStatus,
      requirementResponses: data.requirement_responses || [],
      claimEvidence: data.claim_evidence || [],
    })
    if (grounding?.responseSent) return
    if (targetStatus === 'final' && grounding && !grounding.audit.can_finalize) {
      return res.status(422).json({
        error: 'draft_grounding_failed',
        message: 'Draft cannot be finalized until mandatory requirements and applicant claims are grounded.',
        audit: grounding.audit,
      })
    }

    const row = await runDraftWriteTransaction(req.db, async (tx) => {
      await tx.prepare(
        `
          UPDATE application_drafts
          SET updated_at = CURRENT_TIMESTAMP,
              section_name = COALESCE(?, section_name),
              section_order = COALESCE(?, section_order),
              prompt = COALESCE(?, prompt),
              content = COALESCE(?, content),
              ai_suggestions = COALESCE(?, ai_suggestions),
              word_limit = COALESCE(?, word_limit),
              word_count = COALESCE(?, word_count),
              status = COALESCE(?, status)
          WHERE id = ?
        `,
      ).run(
        data.section_name ?? null,
        data.section_order ?? null,
        data.prompt ?? null,
        data.content ?? null,
        data.ai_suggestions ?? null,
        data.word_limit ?? null,
        data.word_count ?? null,
        data.status ?? null,
        String(req.params.id),
      )
      if (grounding?.applicationId) {
        await persistDraftRequirementCoverage(tx, {
          applicationId: grounding.applicationId,
          draftId: String(req.params.id),
          audit: grounding.audit,
        })
      }
      return tx.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    })
    return res.json({ ...row, grounding_audit: grounding?.audit || null })
  } catch (error) {
    routeLogger.error('[application-drafts] update error:', error)
    const status = error?.name === 'ZodError' ? 400 : (Number(error?.status) || 500)
    return res.status(status).json({ error: error?.code || error?.message || String(error), details: error?.issues })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    await req.db.prepare('DELETE FROM application_drafts WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    routeLogger.error('[application-drafts] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router
