import express from 'express'
import { ensureProfileAccess, requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import {
  loadCanonicalStoredOpportunities,
  loadStoredResearchProfile,
} from '../services/research/canonicalStoredOpportunities.js'
import {
  buildResearchFingerprint,
  rankResearchOpportunities,
} from '../services/research/cvPublicationMatcher.js'

const router = express.Router()
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_OPPORTUNITIES = 2_000

function requestError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function requestedOpportunityIds(value) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > MAX_OPPORTUNITIES) {
    throw requestError(`opportunities must be an array of at most ${MAX_OPPORTUNITIES} records`)
  }
  const ids = value.map((opportunity) => String(
    typeof opportunity === 'string' ? opportunity : opportunity?.id ?? opportunity?.opportunity_id ?? '',
  ).trim())
  if (ids.some((id) => !id)) throw requestError('every requested opportunity must have an id')
  if (new Set(ids).size !== ids.length) throw requestError('requested opportunity ids must be unique')
  return ids
}

router.use(requireAuthenticatedUserMiddleware)

router.post('/rank', async (req, res, next) => {
  try {
    const serialized = JSON.stringify(req.body || {})
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      throw requestError('research recommendation request exceeds 2 MB', 413)
    }
    const profileId = String(req.body?.profile_id ?? req.body?.profileId ?? '').trim()
    if (!profileId) {
      throw requestError('profile_id is required')
    }
    if (!(await ensureProfileAccess(req, res, profileId))) return
    const ids = requestedOpportunityIds(req.body?.opportunities)
    const [storedProfile, canonical] = await Promise.all([
      loadStoredResearchProfile(req.db, profileId),
      loadCanonicalStoredOpportunities(req.db, { profileId, opportunityIds: ids }),
    ])

    let fingerprint
    let ranking
    try {
      fingerprint = buildResearchFingerprint({
        cvText: req.body?.cv_text,
        publications: req.body?.publications,
        profile: storedProfile,
        referenceYear: req.body?.reference_year,
      })
      ranking = rankResearchOpportunities({
        fingerprint,
        opportunities: canonical.opportunities,
        limit: req.body?.limit,
      })
    } catch (error) {
      if (!error.status) error.status = 400
      throw error
    }
    const unavailable = canonical.unavailableIds.map((id) => ({
      id,
      reason: 'canonical_profile_match_unavailable',
    }))
    return res.json({
      profile_id: profileId,
      fingerprint,
      ...ranking,
      excluded: [...ranking.excluded, ...unavailable],
      canonical_source: 'profile_opportunity_matches',
    })
  } catch (error) {
    return next(error)
  }
})

export default router
