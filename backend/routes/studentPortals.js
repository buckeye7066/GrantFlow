/**
 * /api/profiles/:profileId/student-portals — list/create/update student
 *   portal records for a profile.
 * /api/profiles/:profileId/funding-portal-links — list portal-link
 *   classifications.
 * /api/opportunities/:opportunityId/link-student-portal — re-classify a
 *   funding opportunity against a profile.
 *
 * Mounted in backend/server.js as plain routers (not under
 * /api/profiles/* — that conflicts with the existing profiles router
 * which also handles /:id/sections etc.). The route patterns here use
 * the same /:profileId path so the URL is identical from the client's
 * point of view; we just mount this on a dedicated path.
 */

import express from 'express'
import { requireAuthenticatedUser, getAuthUserId, getAccessibleProfileIds } from '../utils/accessControl.js'
import { withProfileScope } from '../middleware/profileContext.js'
import {
  listStudentPortals,
  upsertStudentPortal,
  setStudentPortalActive,
  PORTAL_TYPES,
  PORTAL_SOURCES,
  CREDENTIAL_STATES,
} from '../services/yana/studentPortalStore.js'
import {
  linkOpportunityToPortal,
  listFundingPortalLinks,
  classifyFundingPortal,
} from '../services/yana/studentFundingPortalLinker.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:student-portals')

const router = express.Router()

async function userMayAccessProfile(req, profileId) {
  const user = req.user || { role: 'guest' }
  if (!profileId) return false
  if (user.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // admin
  return accessible.has(String(profileId))
}

router.get('/profiles/:profileId/student-portals', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  try {
    const portals = await withProfileScope(
      { profileId, userId: getAuthUserId(user), bypass: user.role === 'admin' },
      () => listStudentPortals(req.db, profileId, { includeInactive: false }),
    )
    return res.json({ ok: true, portals })
  } catch (err) {
    log.error('GET /profiles/:profileId/student-portals failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'student_portals_list_failed' })
  }
})

router.post('/profiles/:profileId/student-portals', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const body = req.body || {}
  if (!PORTAL_TYPES.includes(body.portal_type)) {
    return res.status(400).json({
      error: 'invalid portal_type',
      allowed_portal_types: PORTAL_TYPES,
    })
  }
  if (body.source && !PORTAL_SOURCES.includes(body.source)) {
    return res.status(400).json({ error: 'invalid source', allowed_sources: PORTAL_SOURCES })
  }
  if (body.credentials_status && !CREDENTIAL_STATES.includes(body.credentials_status)) {
    return res.status(400).json({ error: 'invalid credentials_status', allowed: CREDENTIAL_STATES })
  }
  try {
    const portal = await upsertStudentPortal(req.db, profileId, {
      ...body,
      // Routing/login fields are user-supplied → mark source = user_entered unless explicit.
      source: body.source || 'user_entered',
      user_id: getAuthUserId(user),
    })
    return res.json({ ok: true, portal })
  } catch (err) {
    log.error('POST /profiles/:profileId/student-portals failed', { error: err?.message })
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'student_portals_create_failed' })
  }
})

router.patch('/profiles/:profileId/student-portals/:portalId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId, portalId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const body = req.body || {}
  try {
    if (body.active === false) {
      const ok = await setStudentPortalActive(req.db, profileId, portalId, false)
      return res.json({ ok, deactivated: ok })
    }
    if (body.active === true) {
      const ok = await setStudentPortalActive(req.db, profileId, portalId, true)
      return res.json({ ok, reactivated: ok })
    }
    // Otherwise treat as upsert — caller must include portal_type
    const portal = await upsertStudentPortal(req.db, profileId, { ...body, user_id: getAuthUserId(user), source: body.source || 'user_entered' })
    return res.json({ ok: true, portal })
  } catch (err) {
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'student_portals_update_failed' })
  }
})

router.get('/profiles/:profileId/funding-portal-links', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profileId } = req.params
  if (!(await userMayAccessProfile(req, profileId))) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  try {
    const links = await listFundingPortalLinks(req.db, profileId)
    return res.json({ ok: true, links })
  } catch (err) {
    log.error('GET funding-portal-links failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'funding_portal_links_failed' })
  }
})

router.post('/opportunities/:opportunityId/link-student-portal', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { opportunityId } = req.params
  const body = req.body || {}
  const profileId = String(body.profile_id || body.profileId || '')
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })
  if (!(await userMayAccessProfile(req, profileId))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    let opportunity = body.opportunity || null
    if (!opportunity) {
      try {
        opportunity = await req.db
          .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
          .get(String(opportunityId))
      } catch { opportunity = null }
    }
    if (!opportunity) return res.status(404).json({ error: 'opportunity_not_found' })

    let profile = body.profile || null
    if (!profile) {
      profile = await req.db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(profileId)
      if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    }

    const link = await linkOpportunityToPortal(req.db, {
      profile,
      profileId,
      opportunity: { ...opportunity, id: opportunity.id || opportunityId },
      grantId: body.grant_id || body.grantId || null,
      userId: getAuthUserId(user),
    })
    return res.json({ ok: true, link })
  } catch (err) {
    log.error('POST link-student-portal failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || 'link_failed' })
  }
})

/** Preview-only: classify without persisting. Useful for the
 *  "explain my portal choice" panel. */
router.post('/student-portals/classify-preview', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const { profile, opportunity } = req.body || {}
  if (!profile || !opportunity) return res.status(400).json({ error: 'profile and opportunity required' })
  if (profile.id && !(await userMayAccessProfile(req, profile.id))) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  try {
    const classification = classifyFundingPortal({ profile, opportunity })
    return res.json({ ok: true, classification })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'classify_failed' })
  }
})

export default router
