import express from 'express'
import {
  ensureProfileAccess,
  getAuthUserId,
  isAdminUserWithDb,
  requireAuthenticatedUserMiddleware,
} from '../utils/accessControl.js'
import {
  PROFILE_MEMORY_CONTRACT,
  ProfileMemoryError,
  createProfileMemory,
  deleteProfileMemoryEntry,
  getProfileMemoryDeletionReadiness,
  getProfileMemoryEntry,
  listProfileMemory,
  listProfileMemoryRevisions,
  reviseProfileMemory,
  setProfileMemoryRetention,
} from '../services/profileMemoryRepository.js'

const router = express.Router()

router.use(requireAuthenticatedUserMiddleware)

function actorUserId(req) {
  return req.ctx?.userId ?? getAuthUserId(req.user) ?? null
}

async function authorize(req, res) {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!profileId) {
    res.status(400).json({ error: 'profile_id required' })
    return null
  }
  if (!(await ensureProfileAccess(req, res, profileId))) return null
  return profileId
}

async function retentionAuthority(req, profileId) {
  const actorId = actorUserId(req)
  const [actorIsAdmin, profile] = await Promise.all([
    isAdminUserWithDb(req.db, req.user),
    req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId),
  ])
  return {
    actorIsAdmin,
    actorIsOwner: Boolean(actorId && profile?.user_id && String(actorId) === String(profile.user_id)),
  }
}

async function requireOwnerOrAdmin(req, res, profileId) {
  const authority = await retentionAuthority(req, profileId)
  if (authority.actorIsAdmin || authority.actorIsOwner) return authority
  res.status(403).json({ error: 'Only the profile owner or an administrator may access retained memory history' })
  return null
}

function inputFromBody(req, profileId, authority = {}) {
  const body = req.body ?? {}
  return {
    profileId,
    entryId: req.params.entryId,
    memoryKey: body.memory_key ?? body.memoryKey,
    title: body.title,
    kind: body.kind,
    value: body.value,
    sourceKind: body.source_kind ?? body.sourceKind,
    sourceRef: body.source_ref ?? body.sourceRef,
    provenance: body.provenance,
    retentionPolicy: body.retention_policy ?? body.retentionPolicy,
    retentionUntil: body.retention_until ?? body.retentionUntil,
    legalHoldReason: body.legal_hold_reason ?? body.legalHoldReason,
    actorUserId: actorUserId(req),
    actorIsAdmin: authority.actorIsAdmin === true,
    actorIsOwner: authority.actorIsOwner === true,
  }
}

function sendError(res, error) {
  if (!(error instanceof ProfileMemoryError)) {
    return res.status(500).json({ error: 'Failed to process profile memory request' })
  }
  const status = error.code === 'MEMORY_PROFILE_NOT_FOUND' || error.code === 'MEMORY_NOT_FOUND'
    ? 404
    : error.code === 'MEMORY_ADMIN_REQUIRED' || error.code === 'MEMORY_OWNER_REQUIRED'
      ? 403
    : error.code === 'MEMORY_KEY_CONFLICT' || error.code === 'MEMORY_RETENTION_HOLD'
      ? 409
      : 400
  return res.status(status).json({ error: error.message, code: error.code, details: error.details ?? undefined })
}

router.get('/:profileId/memory/contract', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    if (!(await requireOwnerOrAdmin(req, res, profileId))) return
    const readiness = await getProfileMemoryDeletionReadiness(req.db, { profileId })
    return res.json({ contract: PROFILE_MEMORY_CONTRACT, deletion_readiness: readiness })
  } catch (error) {
    return sendError(res, error)
  }
})

router.get('/:profileId/memory', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const includeDeleted = String(req.query.include_deleted ?? '').toLowerCase() === 'true'
    if (includeDeleted && !(await requireOwnerOrAdmin(req, res, profileId))) return
    const items = await listProfileMemory(req.db, {
      profileId,
      includeDeleted,
      limit: req.query.limit,
    })
    return res.json({ profile_id: profileId, contract_version: PROFILE_MEMORY_CONTRACT.version, items })
  } catch (error) {
    return sendError(res, error)
  }
})

router.get('/:profileId/memory/:entryId/revisions', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    if (!(await requireOwnerOrAdmin(req, res, profileId))) return
    const revisions = await listProfileMemoryRevisions(req.db, {
      profileId,
      entryId: req.params.entryId,
      limit: req.query.limit,
    })
    if (!revisions) return res.status(404).json({ error: 'Memory entry not found' })
    return res.json({ profile_id: profileId, entry_id: req.params.entryId, revisions })
  } catch (error) {
    return sendError(res, error)
  }
})

router.get('/:profileId/memory/:entryId', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const item = await getProfileMemoryEntry(req.db, { profileId, entryId: req.params.entryId })
    if (!item) return res.status(404).json({ error: 'Memory entry not found' })
    if (item.status !== 'active' && !(await requireOwnerOrAdmin(req, res, profileId))) return
    return res.json({ item })
  } catch (error) {
    return sendError(res, error)
  }
})

router.post('/:profileId/memory', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const authority = await retentionAuthority(req, profileId)
    const item = await createProfileMemory(req.db, inputFromBody(req, profileId, authority))
    return res.status(201).json({ item })
  } catch (error) {
    return sendError(res, error)
  }
})

router.patch('/:profileId/memory/:entryId', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const item = await reviseProfileMemory(req.db, inputFromBody(req, profileId))
    return res.json({ item })
  } catch (error) {
    return sendError(res, error)
  }
})

router.put('/:profileId/memory/:entryId/retention', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const authority = await retentionAuthority(req, profileId)
    const item = await setProfileMemoryRetention(
      req.db,
      inputFromBody(req, profileId, authority),
    )
    return res.json({ item, contract_version: PROFILE_MEMORY_CONTRACT.version })
  } catch (error) {
    return sendError(res, error)
  }
})

router.delete('/:profileId/memory/:entryId', async (req, res) => {
  try {
    const profileId = await authorize(req, res)
    if (!profileId) return
    const authority = await requireOwnerOrAdmin(req, res, profileId)
    if (!authority) return
    const item = await deleteProfileMemoryEntry(req.db, {
      profileId,
      entryId: req.params.entryId,
      actorUserId: actorUserId(req),
      actorIsAdmin: authority.actorIsAdmin,
      actorIsOwner: authority.actorIsOwner,
      reason: req.body?.reason ?? 'user_requested',
    })
    return res.json({ item, redacted: true, contract_version: PROFILE_MEMORY_CONTRACT.version })
  } catch (error) {
    return sendError(res, error)
  }
})

export default router
