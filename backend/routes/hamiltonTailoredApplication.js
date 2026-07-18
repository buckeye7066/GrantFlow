/**
 * /api/hamilton/tailored/*
 *
 * Per-funder tailored-application review surface. Each portal card (a pipeline
 * grant) carries ONE tailored application: the funder-specific, MBA-level,
 * fabrication-guarded narrative Hamilton drafted, plus its review state and any
 * open questions the applicant must answer before the card can be submitted.
 *
 * Endpoints (stable contract shared with the frontend sibling):
 *   GET  /api/hamilton/tailored/application?grant_id=…  →
 *          { fields, status, missing_questions, funder_requirements,
 *            can_auto_submit, gate_reason }
 *   POST /api/hamilton/tailored/approve      { grant_id }          → approve
 *   POST /api/hamilton/tailored/edit         { grant_id, fields }  → approve-as-edited
 *   POST /api/hamilton/tailored/regenerate   { grant_id }          → redraft (→ pending)
 *
 * All routes require authentication; the caller must own (or be admin for) the
 * grant's profile. Approval is BLOCKED while missing_questions is non-empty.
 */

import express from 'express'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
  getAuthUserId,
} from '../utils/accessControl.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'
import {
  getTailoredApplication,
  approveTailoredApplication,
  saveTailoredApplicationEdit,
} from '../services/hamilton/tailoredApplicationStore.js'
import {
  generateTailoredNarrative,
  evaluateAutoSubmitGate,
  reconcileTailoredApplication,
  isApprovalBlocked,
} from '../services/hamilton/tailoredNarrative.js'
import { insertActivityEvent } from '../services/agentTelemetry/agentTelemetryStore.js'

const router = express.Router()

async function loadProfileBundle(db, profileId) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    if (!row) return null
    let sectionRows = []
    try {
      sectionRows = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(String(profileId))
    } catch { sectionRows = [] }
    const sections = {}
    for (const r of sectionRows || []) {
      try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
    }
    try {
      const derived = deriveNamePartsIntoBasicInfo(sections.basic_information || {}, row.display_name)
      if (derived.changed) sections.basic_information = derived.data
    } catch { /* non-fatal */ }
    return { ...row, sections, ...sections }
  } catch { return null }
}

/**
 * Resolve the grant → its profile + opportunity, and authorize the caller.
 * Returns { user, grantId, grant, profile } or null (response already sent).
 */
async function loadGrantAndAuthorise(req, res, grantId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null
  if (!grantId) {
    res.status(400).json({ error: 'grant_id_required' })
    return null
  }
  let grant = null
  try {
    grant = await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(grantId))
  } catch { grant = null }
  if (!grant) {
    res.status(404).json({ error: 'grant_not_found' })
    return null
  }
  const profileId = grant.profile_id
  if (req.ctx?.isAdmin !== true) {
    const accessible = await getAccessibleProfileIds(req.db, user)
    if (accessible !== null && !accessible.has(String(profileId))) {
      res.status(403).json({ error: 'forbidden' })
      return null
    }
  }
  const profile = await loadProfileBundle(req.db, profileId)
  return { user, grantId: String(grantId), grant, profile, profileId }
}

/**
 * Assemble the canonical response payload for a card, including the live
 * auto-submit gate verdict so the UI can show exactly why a card can/can't
 * auto-submit.
 */
async function buildPayload(db, { profileId, grantId, grant, profile }) {
  const opportunityId = grant?.funding_opportunity_id || null
  let opportunity = null
  if (opportunityId) {
    try { opportunity = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(opportunityId)) } catch { opportunity = null }
  }
  // Reconcile first: an inputs-hash mismatch (essays/funder changed) bounces a
  // stale approval back to pending before we report status.
  await reconcileTailoredApplication(db, { profileId, grantId, profile, opportunity, grant })
  const record = await getTailoredApplication(db, { profileId, grantId })
  const gate = await evaluateAutoSubmitGate(db, { profileId, grantId, profile, opportunity, grant })
  return {
    exists: !!record,
    fields: record?.fields || {},
    status: record?.status || null,
    missing_questions: record?.missing_questions || [],
    funder_requirements: record?.funder_requirements || {},
    can_auto_submit: gate.submit,
    gate_reason: gate.reason,
  }
}

// GET the tailored application for a card.
router.get('/application', async (req, res) => {
  const ctx = await loadGrantAndAuthorise(req, res, req.query.grant_id)
  if (!ctx) return
  try {
    const payload = await buildPayload(req.db, ctx)
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: 'tailored_fetch_failed', detail: err?.message })
  }
})

// POST approve — status → approved. BLOCKED while missing_questions is non-empty.
router.post('/approve', async (req, res) => {
  const ctx = await loadGrantAndAuthorise(req, res, req.body?.grant_id)
  if (!ctx) return
  try {
    const opportunityId = ctx.grant?.funding_opportunity_id || null
    let opportunity = null
    if (opportunityId) {
      try { opportunity = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(opportunityId)) } catch { opportunity = null }
    }
    await reconcileTailoredApplication(req.db, { ...ctx, opportunity })
    const record = await getTailoredApplication(req.db, ctx)
    if (!record) {
      return res.status(404).json({ error: 'tailored_application_not_found' })
    }
    if (isApprovalBlocked(record)) {
      return res.status(409).json({
        error: 'approval_blocked_missing_info',
        missing_questions: record.missing_questions,
      })
    }
    await approveTailoredApplication(req.db, { ...ctx, approvedBy: getAuthUserId(ctx.user) })
    await insertActivityEvent(req.db, {
      agent_name: 'hamilton',
      event_type: 'tailored_narrative_approved',
      status: 'ok',
      title: 'Applicant approved Hamilton\'s tailored application',
      entity_type: 'grant',
      entity_id: ctx.grantId,
      profile_id: ctx.profileId,
      user_id: getAuthUserId(ctx.user),
    }).catch(() => {})
    const payload = await buildPayload(req.db, ctx)
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: 'tailored_approve_failed', detail: err?.message })
  }
})

// POST edit — save edited fields, status → edited (approved-as-edited).
router.post('/edit', async (req, res) => {
  const ctx = await loadGrantAndAuthorise(req, res, req.body?.grant_id)
  if (!ctx) return
  const fields = req.body?.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields_object_required' })
  }
  try {
    const record = await getTailoredApplication(req.db, ctx)
    if (!record) return res.status(404).json({ error: 'tailored_application_not_found' })
    if (isApprovalBlocked(record)) {
      return res.status(409).json({
        error: 'approval_blocked_missing_info',
        missing_questions: record.missing_questions,
      })
    }
    await saveTailoredApplicationEdit(req.db, { ...ctx, fields, approvedBy: getAuthUserId(ctx.user) })
    await insertActivityEvent(req.db, {
      agent_name: 'hamilton',
      event_type: 'tailored_narrative_edited',
      status: 'ok',
      title: 'Applicant edited & approved Hamilton\'s tailored application',
      entity_type: 'grant',
      entity_id: ctx.grantId,
      profile_id: ctx.profileId,
      user_id: getAuthUserId(ctx.user),
    }).catch(() => {})
    const payload = await buildPayload(req.db, ctx)
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: 'tailored_edit_failed', detail: err?.message })
  }
})

// POST regenerate — redraft from current essays/funder, status → pending.
router.post('/regenerate', async (req, res) => {
  const ctx = await loadGrantAndAuthorise(req, res, req.body?.grant_id)
  if (!ctx) return
  try {
    const result = await generateTailoredNarrative(req.db, {
      profileId: ctx.profileId,
      grantId: ctx.grantId,
      profile: ctx.profile,
      grant: ctx.grant,
      userId: getAuthUserId(ctx.user),
    })
    if (!result.ok) {
      return res.status(422).json({ error: result.error || 'generation_failed' })
    }
    const payload = await buildPayload(req.db, ctx)
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: 'tailored_regenerate_failed', detail: err?.message })
  }
})

export default router
