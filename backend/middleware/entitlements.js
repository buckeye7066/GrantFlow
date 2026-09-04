import { requireTierCapability } from '../utils/tierGating.js'
import { TIER_CAPABILITIES } from '../utils/tierGating.js'
import { ADMIN_PROFILE_SENTINEL } from '../config/userProfileMappings.js'

export function resolveProfileId(req) {
  const fromParams = req?.params?.profileId ?? req?.params?.profile_id ?? null
  const fromBody = req?.body?.profile_id ?? req?.body?.profileId ?? null
  const fromQuery = req?.query?.profileId ?? req?.query?.profile_id ?? null
  const fromCtx = req?.ctx?.activeProfileId ?? null
  const fromHeader = req?.headers?.['x-profile-id'] ?? req?.headers?.['X-Profile-Id'] ?? null

  const candidate = fromParams ?? fromBody ?? fromQuery ?? fromCtx ?? fromHeader ?? null
  const normalized = candidate ? String(candidate).trim() : ''
  if (!normalized || normalized === ADMIN_PROFILE_SENTINEL) return null
  return normalized
}

function identifierFromPath(req, segment) {
  // originalUrl retains the app.use() mount prefix. req.path may be only
  // `/:id/...` by the time this middleware runs, which made task ids invisible
  // at the route-wide entitlement choke point.
  const path = String(req?.originalUrl || `${req?.baseUrl || ''}${req?.path || ''}`).split('?')[0]
  const match = new RegExp(`/${segment}/([^/]+)`, 'i').exec(path)
  if (!match?.[1]) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

function identifierFromPattern(req, pattern) {
  const path = String(req?.originalUrl || `${req?.baseUrl || ''}${req?.path || ''}`).split('?')[0]
  const match = pattern.exec(path)
  if (!match?.[1]) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

async function recordProfileId(db, table, id) {
  if (!id) return null
  const row = await db.prepare(`SELECT profile_id FROM ${table} WHERE id = ? LIMIT 1`).get(String(id))
  return row?.profile_id ? String(row.profile_id) : null
}

/**
 * Resolve indirect Hamilton identities before an entitlement decision. A task
 * id or grant id is not a profile id; treating generic `params.id` as one made
 * route-wide enforcement impossible and could evaluate the wrong account.
 */
export async function resolveEntitlementProfileId(req, { getCloudLoginMetaFn = null } = {}) {
  if (!req?.db) return null

  const explicitCandidate = req?.params?.profileId
    ?? req?.params?.profile_id
    ?? req?.body?.profile_id
    ?? req?.body?.profileId
    ?? req?.query?.profileId
    ?? req?.query?.profile_id
    ?? null
  const explicitProfileId = explicitCandidate ? String(explicitCandidate).trim() : null
  const indirectProfileIds = []

  const taskId = req?.params?.taskId
    ?? req?.params?.task_id
    ?? req?.body?.task_id
    ?? req?.query?.task_id
    ?? identifierFromPath(req, 'tasks')
    ?? identifierFromPath(req, 'application-tasks')
  if (taskId) {
    const row = await req.db.prepare(
      'SELECT profile_id FROM application_tasks WHERE id = ? LIMIT 1',
    ).get(String(taskId))
    if (row?.profile_id) indirectProfileIds.push(String(row.profile_id))
  }

  const grantId = req?.params?.grantId
    ?? req?.params?.grant_id
    ?? req?.body?.grant_id
    ?? req?.query?.grant_id
    ?? identifierFromPath(req, 'grants')
  if (grantId) {
    const row = await req.db.prepare(
      'SELECT profile_id FROM grants WHERE id = ? LIMIT 1',
    ).get(String(grantId))
    if (row?.profile_id) indirectProfileIds.push(String(row.profile_id))
  }

  // These Hamilton routes expose profile-owned records through a generic
  // `:id`. Resolve the record owner before billing rather than borrowing the
  // caller-controlled active-profile header and checking ownership later.
  const ownedRecords = [
    ['hamilton_authorizations', identifierFromPattern(req, /\/authorizations\/([^/]+)\/revoke(?:\/|$)/i)],
    ['hamilton_session_capture_requests', identifierFromPattern(req, /\/sessions\/capture-requests\/([^/]+)\/(?:launched|cancel)(?:\/|$)/i)],
    ['hamilton_saved_sessions', identifierFromPattern(req, /\/sessions\/([^/]+)\/(?:revoke|expire)(?:\/|$)/i)],
    ['hamilton_portal_credentials', identifierFromPattern(req, /\/(?:admin\/)?credentials\/([^/]+)(?:\/reveal-once|\/move|\/copy|\/|$)/i)],
    ['hamilton_attestation_authorizations', identifierFromPattern(req, /\/attestations\/([^/]+)\/revoke(?:\/|$)/i)],
  ]
  for (const [table, id] of ownedRecords) {
    const owner = await recordProfileId(req.db, table, id)
    if (owner) indirectProfileIds.push(owner)
  }

  const liveSessionId = identifierFromPattern(
    req,
    /\/sessions\/cloud-login\/([^/]+)\/(?:stream|input|complete|cancel)(?:\/|$)/i,
  )
  if (liveSessionId) {
    const lookup = getCloudLoginMetaFn
      ?? (await import('../services/hamilton/hamiltonCloudLogin.js')).getCloudLoginMeta
    const owner = lookup(liveSessionId)?.profileId
    if (owner) indirectProfileIds.push(String(owner))
  }

  const uniqueIndirect = [...new Set(indirectProfileIds)]
  if (uniqueIndirect.length > 1 || (
    uniqueIndirect.length === 1 &&
    explicitProfileId &&
    explicitProfileId !== uniqueIndirect[0]
  )) {
    const error = new Error('entitlement_profile_mismatch')
    error.code = 'entitlement_profile_mismatch'
    error.status = 409
    throw error
  }
  if (uniqueIndirect.length === 1) return uniqueIndirect[0]
  if (explicitProfileId && explicitProfileId !== ADMIN_PROFILE_SENTINEL) return explicitProfileId

  const contextual = req?.ctx?.activeProfileId
    ?? req?.headers?.['x-profile-id']
    ?? req?.headers?.['X-Profile-Id']
    ?? null
  const normalizedContextual = contextual ? String(contextual).trim() : ''
  return normalizedContextual && normalizedContextual !== ADMIN_PROFILE_SENTINEL
    ? normalizedContextual
    : null
}

async function profileExists(db, profileId) {
  if (!db || !profileId) return false
  const row = await db.prepare('SELECT id FROM profiles WHERE id = ?').get(String(profileId))
  return Boolean(row?.id)
}

export function enforceTierCapability(capabilityKey, { profileIdResolver } = {}) {
  return async (req, res, next) => {
    try {
      if (!req?.user || req.user.role === 'guest') {
        return res.status(401).json({ error: 'not_authenticated' })
      }
      const ctxIsAdmin = req?.ctx?.isAdmin === true
      const resolved = profileIdResolver
        ? await profileIdResolver(req)
        : await resolveEntitlementProfileId(req)
      const profileId = resolved ? String(resolved).trim() : ''

      if (!profileId) {
        if (ctxIsAdmin) return next()
        return res.status(400).json({ error: 'profile_id required', capability: capabilityKey })
      }

      if (!req.db) return res.status(503).json({ error: 'entitlement_authority_unavailable' })
      const okProfile = await profileExists(req.db, profileId)
      if (!okProfile) {
        return res.status(404).json({ error: 'profile_not_found', profile_id: profileId })
      }

      const allowed = await requireTierCapability(req, res, profileId, capabilityKey)
      if (!allowed) return undefined
      req.entitlementProfileId = profileId
      return next()
    } catch (error) {
      console.error('[entitlements] tier enforcement failed:', error)
      const mismatch = error?.code === 'entitlement_profile_mismatch'
      return res.status(mismatch ? 409 : 503).json({
        error: mismatch ? 'entitlement_profile_mismatch' : 'entitlement_authority_unavailable',
        message: mismatch
          ? 'The requested task or grant belongs to a different profile than the supplied billing context.'
          : 'Billing entitlements could not be verified. The feature remains locked.',
      })
    }
  }
}

export function getCrawlerJobCapability(type, { enableAi } = {}) {
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  if (!t) return null

  if (t === 'item_search') return TIER_CAPABILITIES.ITEM_FUNDING
  if (t === 'pipeline_automation') return TIER_CAPABILITIES.PIPELINE_AUTOMATION
  if (t === 'document_ingest') return TIER_CAPABILITIES.DOCUMENT_AI
  if (t === 'profile_enrichment') return TIER_CAPABILITIES.DOCUMENT_AI
  if (t === 'avatar_lookup') return TIER_CAPABILITIES.DOCUMENT_AI
  if (t === 'document_ingest_v2') return enableAi ? TIER_CAPABILITIES.DOCUMENT_AI : null
  return null
}

export function enforceCrawlerJobTier() {
  return async (req, res, next) => {
    try {
      if (!req?.user || req.user.role === 'guest') {
        return res.status(401).json({ error: 'not_authenticated' })
      }
      const capability = getCrawlerJobCapability(req?.body?.type, {
        enableAi: req?.body?.enable_ai === true,
      })
      if (!capability) return next()

      const profileId = await resolveEntitlementProfileId(req)
      if (!profileId) {
        if (req?.ctx?.isAdmin === true) return next()
        return res.status(400).json({ error: 'profile_id required', capability })
      }
      if (!req.db) return res.status(503).json({ error: 'entitlement_authority_unavailable' })
      if (!(await profileExists(req.db, profileId))) {
        return res.status(404).json({ error: 'profile_not_found', profile_id: profileId })
      }

      const allowed = await requireTierCapability(req, res, profileId, capability)
      if (!allowed) return undefined
      req.entitlementProfileId = profileId
      return next()
    } catch (error) {
      console.error('[entitlements] crawler job tier enforcement failed:', error)
      const mismatch = error?.code === 'entitlement_profile_mismatch'
      return res.status(mismatch ? 409 : 503).json({
        error: mismatch ? 'entitlement_profile_mismatch' : 'entitlement_authority_unavailable',
        message: mismatch
          ? 'The crawler job target does not match the supplied profile billing context.'
          : 'Billing entitlements could not be verified. The crawler job was not started.',
        request_id: req.requestId || null,
      })
    }
  }
}
