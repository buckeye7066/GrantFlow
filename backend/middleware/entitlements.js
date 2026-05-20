import { requireTierCapability } from '../utils/tierGating.js'
import { TIER_CAPABILITIES } from '../utils/tierGating.js'
import { ADMIN_PROFILE_SENTINEL } from '../config/userProfileMappings.js'

export function resolveProfileId(req) {
  const fromParams = req?.params?.profileId ?? req?.params?.profile_id ?? req?.params?.id ?? null
  const fromBody = req?.body?.profile_id ?? req?.body?.profileId ?? null
  const fromQuery = req?.query?.profileId ?? req?.query?.profile_id ?? null
  const fromCtx = req?.ctx?.activeProfileId ?? null
  const fromHeader = req?.headers?.['x-profile-id'] ?? req?.headers?.['X-Profile-Id'] ?? null

  const candidate = fromParams ?? fromBody ?? fromQuery ?? fromCtx ?? fromHeader ?? null
  const normalized = candidate ? String(candidate).trim() : ''
  if (!normalized || normalized === ADMIN_PROFILE_SENTINEL) return null
  return normalized
}

async function profileExists(db, profileId) {
  if (!db || !profileId) return false
  try {
    const row = await db.prepare('SELECT id FROM profiles WHERE id = ?').get(String(profileId))
    return Boolean(row?.id)
  } catch {
    return false
  }
}

export function enforceTierCapability(capabilityKey, { profileIdResolver } = {}) {
  return async (req, res, next) => {
    try {
      const ctxIsAdmin = Boolean(req?.ctx?.isAdmin)
      const resolved = profileIdResolver ? await profileIdResolver(req) : resolveProfileId(req)
      const profileId = resolved ? String(resolved).trim() : ''

      if (!profileId) {
        if (ctxIsAdmin) return next()
        return res.status(400).json({ error: 'profile_id required', capability: capabilityKey })
      }

      if (!req.db) { return res.status(500).json({ error: 'Database connection unavailable' }); }
      const okProfile = await profileExists(req.db, profileId)
      if (!okProfile) {
        return res.status(400).json({ error: 'Profile not found', profile_id: profileId })
      }

      const allowed = await requireTierCapability(req, res, profileId, capabilityKey)
      if (!allowed) return
      return next()
    } catch (error) {
      console.error('[entitlements] tier enforcement failed:', error)
      return res.status(500).json({ error: 'Tier enforcement failed' })
    }
  }
}

export function getCrawlerJobCapability(type, { enableAi } = {}) {
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  if (!t) return null

  if (t === 'item_search') return TIER_CAPABILITIES.ITEM_FUNDING
  if (t === 'pipeline_automation') return TIER_CAPABILITIES.PIPELINE_AUTOMATION

  // document_ingest jobs are the AI-dependent document enrichment step.
  // Baseline ingest (upload + OCR/text extraction) is handled elsewhere and is not gated.
  if (t === 'document_ingest') return TIER_CAPABILITIES.DOCUMENT_AI

  // Other AI-dependent crawler jobs.
  if (t === 'profile_enrichment') return TIER_CAPABILITIES.DOCUMENT_AI
  if (t === 'avatar_lookup') return TIER_CAPABILITIES.DOCUMENT_AI

  // If we ever introduce a non-AI document ingest job, gate only when enableAi is requested.
  if (t === 'document_ingest_v2') {
    if (enableAi) return TIER_CAPABILITIES.DOCUMENT_AI
    return null
  }

  return null
}

export function enforceCrawlerJobTier() {
  return async (req, res, next) => {
    try {
      const type = req?.body?.type
      const capability = getCrawlerJobCapability(type, { enableAi: req?.body?.enable_ai === true })
      if (!capability) return next()

      // Crawler jobs are always profile-scoped for paid features.
      const profileId = resolveProfileId(req)
      if (!profileId) {
        if (req?.ctx?.isAdmin) return next()
        return res.status(400).json({ error: 'profile_id required', capability })
      }

      if (!req.db) { return res.status(500).json({ error: 'Database connection unavailable' }); }
      const okProfile = await profileExists(req.db, profileId)
      if (!okProfile) {
        return res.status(400).json({ error: 'Profile not found', profile_id: profileId })
      }

      const allowed = await requireTierCapability(req, res, profileId, capability)
      if (!allowed) return
      return next()
    } catch (error) {
      console.error('[entitlements] crawler job tier enforcement failed:', error)
      return res.status(500).json({
        error: 'tier_enforcement_failed',
        message: 'Tier enforcement failed. Please retry shortly.',
        request_id: req.requestId || null,
      })
    }
  }
}

