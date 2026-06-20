/**
 * /api/profiles/:id/portals
 *
 * The per-profile "Portals" dashboard data source. Returns every portal that
 * applies to a profile — prepopulated with a resolved sign-in URL + friendly
 * label + a green/red status — so the UI never asks the user to type a portal
 * name or URL. Hamilton owns the login URL; the user only ever supplies
 * username/password/2FA elsewhere.
 *
 * The portal set is derived (deduped by registrable host) from the profile's
 * pipeline grants, target colleges / university_applications, and any
 * credential/session the profile already holds — see profilePortalIndex.js.
 *
 * Auth: authenticated caller, profile-access scoped exactly like the rest of the
 * profile surface (admin sees all; others only profiles they can access).
 *
 * Degrades gracefully: a profile with no portals returns { portals: [] }, and
 * the resolver never throws, so this endpoint does not 500 on sparse data.
 *
 * Mounted at /api so the path is /api/profiles/:id/portals — alongside the
 * studentPortals + committedCollege routers, without colliding with the main
 * profiles router (which owns /api/profiles/:id itself).
 */

import express from 'express'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import { getProfilePortals } from '../services/hamilton/profilePortalIndex.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:profile-portals')
const router = express.Router()

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (user?.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // global access
  return accessible.has(String(profileId))
}

router.get('/profiles/:id/portals', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const result = await getProfilePortals(req.db, profileId)
    return res.json(result)
  } catch (err) {
    // getProfilePortals already degrades to { portals: [] } internally; this is
    // a final net so the dashboard never sees a 500.
    log.error('profile_portals_failed', { profileId, err: err?.message })
    return res.json({ portals: [] })
  }
})

export default router
