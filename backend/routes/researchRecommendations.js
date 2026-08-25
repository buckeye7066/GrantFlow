import express from 'express'
import { ensureProfileAccess, requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import {
  buildResearchFingerprint,
  rankResearchOpportunities,
} from '../services/research/cvPublicationMatcher.js'

const router = express.Router()
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

router.use(requireAuthenticatedUserMiddleware)

router.post('/rank', async (req, res, next) => {
  try {
    const serialized = JSON.stringify(req.body || {})
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      const error = new Error('research recommendation request exceeds 2 MB')
      error.status = 413
      throw error
    }
    const profileId = String(req.body?.profile_id ?? req.body?.profileId ?? '').trim()
    if (!profileId) {
      const error = new Error('profile_id is required')
      error.status = 400
      throw error
    }
    if (!(await ensureProfileAccess(req, res, profileId))) return
    const fingerprint = buildResearchFingerprint({
      cvText: req.body?.cv_text,
      publications: req.body?.publications,
      profile: req.body?.profile,
      referenceYear: req.body?.reference_year,
    })
    const ranking = rankResearchOpportunities({
      fingerprint,
      opportunities: req.body?.opportunities,
      limit: req.body?.limit,
    })
    return res.json({ profile_id: profileId, fingerprint, ...ranking })
  } catch (error) {
    if (!error.status) error.status = 400
    return next(error)
  }
})

export default router
