import express from 'express'
import fs from 'fs'
import path from 'path'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  requireAuthenticatedUser,
  requireAuthenticatedUserMiddleware,
  getAuthUserId,
} from '../utils/accessControl.js'
import {
  autoPopulate,
  compileApplicationPackage,
  exportApplicationPackage,
  getApplication,
  validateApplication,
  listChecklist,
  listSections,
  markSubmitted,
  patchApplication,
  prepareApplication,
  setChecklistItem,
  upsertSection,
} from '../apply/applyEngine.js'
import { assertArtifactPathIsSafe } from '../apply/storageAdapter.js'
import { asyncHandler } from '../middleware/errorHandler.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:applications')

const router = express.Router()
router.use(requireAuthenticatedUserMiddleware)

// Auto-wrap every route handler registered below in asyncHandler so a rejected
// promise reaches the central errorHandler instead of hanging until the request
// timeout returns a generic 504. Express 4 does not forward async rejections,
// and these handlers (prepare/validate/compile/export/submit) are async with no
// try/catch — a throw would otherwise be an invisible unhandled rejection.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = router[method].bind(router)
  router[method] = (routePath, ...handlers) =>
    original(routePath, ...handlers.map((h) => (typeof h === 'function' ? asyncHandler(h) : h)))
}

async function ensureApplicationAccess(req, res, applicationId) {
  const userId = getAuthUserId(req?.user ?? req?.ctx)
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }

  const row = await req.db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId && typeof applicationId === 'string' ? applicationId : String(applicationId || ''))
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return null
  }

  const grant = await ensureGrantAccess(req, res, String(row.grant_id))
  if (!grant) return null

  // Extra safety: ensure org access (grant access should already imply this).
  if (row.organization_id) {
    const ok = await ensureOrganizationAccess(req, res, row.organization_id && typeof row.organization_id === 'string' ? row.organization_id : String(row.organization_id || ''))
    if (!ok) return null
  }

  return row
}

router.post('/prepare', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  const { grantId, organizationId } = req.body ?? {}
  if (!grantId || !organizationId) {
    return res.status(400).json({ error: 'grantId and organizationId are required' })
  }

  const grant = await ensureGrantAccess(req, res, grantId && typeof grantId === 'string' ? grantId : String(grantId || ''))
  if (!grant) return

  const okOrg = await ensureOrganizationAccess(req, res, organizationId && typeof organizationId === 'string' ? organizationId : String(organizationId || ''))
  if (!okOrg) return

  const userId = req.ctx?.userId ?? getAuthUserId(req?.user ?? req?.ctx)
  const app = await prepareApplication({
    db: req.db,
    grantId: grantId && typeof grantId === 'string' ? grantId : String(grantId || ''),
    organizationId: organizationId && typeof organizationId === 'string' ? organizationId : String(organizationId || ''),
    userId,
  })
  return res.status(201).json(app)
})

router.get('/:id', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const app = await getApplication({ db: req.db, applicationId: row.id })
  return res.json(app)
})

router.patch('/:id', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const app = await patchApplication({ db: req.db, applicationId: row.id, patch: req.body ?? {} })
  return res.json(app)
})

router.get('/:id/sections', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const sections = await listSections({ db: req.db, applicationId: row.id })
  return res.json(sections)
})

router.put('/:id/sections/:sectionKey', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const { title, content } = req.body ?? {}
  const section = await upsertSection({
    db: req.db,
    applicationId: row.id,
    sectionKey: req.params.sectionKey && typeof req.params.sectionKey === 'string' ? req.params.sectionKey : String(req.params.sectionKey || ''),
    title,
    content,
  })
  return res.json(section)
})

router.get('/:id/checklist', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const items = await listChecklist({ db: req.db, applicationId: row.id })
  return res.json(items)
})

router.put('/:id/checklist/:key', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const { label, status } = req.body ?? {}
  const item = await setChecklistItem({
    db: req.db,
    applicationId: row.id,
    key: req.params.key && typeof req.params.key === 'string' ? req.params.key : String(req.params.key || ''),
    label,
    status,
  })
  return res.json(item)
})

router.post('/:id/validate', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const result = await validateApplication({ db: req.db, applicationId: row.id })
  return res.json(result)
})

router.post('/:id/compile', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const result = await compileApplicationPackage({ db: req.db, applicationId: row.id })
  return res.json(result)
})

router.post('/:id/export', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const { format } = req.body ?? {}
  const result = await exportApplicationPackage({ db: req.db, applicationId: row.id, format })
  return res.json(result)
})

router.post('/:id/submit', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const { method, metadata, confirm_incomplete: confirmIncomplete } = req.body ?? {}
  // 'hamilton' is a provenance claim reserved for the autopilot's own
  // server-side mirror call — an HTTP client may not assert it (it would both
  // fake provenance and bypass the incomplete-checklist confirm).
  const cleanMetadata =
    metadata && typeof metadata === 'object' && String(metadata.submitted_by || '').toLowerCase() === 'hamilton'
      ? { ...metadata, submitted_by: null }
      : metadata
  try {
    const updated = await markSubmitted({
      db: req.db,
      applicationId: row.id,
      method,
      metadata: cleanMetadata,
      confirmIncomplete: confirmIncomplete === true,
    })
    return res.json({ ok: true, application: updated })
  } catch (err) {
    if (err?.code === 'CHECKLIST_INCOMPLETE') {
      return res.status(409).json({
        error: 'CHECKLIST_INCOMPLETE',
        message: err.message,
        incomplete_checklist: err.details?.incomplete_checklist ?? [],
      })
    }
    throw err
  }
})

router.post('/:id/auto-populate', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return
  const result = await autoPopulate({ db: req.db, applicationId: row.id })
  return res.json(result)
})

router.get('/:id/artifacts/:artifactId/download', async (req, res) => {
  const row = await ensureApplicationAccess(req, res, req.params.id)
  if (!row) return

  const artifact = await req.db
    .prepare('SELECT * FROM application_artifacts WHERE id = ? AND application_id = ?')
    .get(req.params.artifactId && typeof req.params.artifactId === 'string' ? req.params.artifactId : String(req.params.artifactId || ''), row.id && typeof row.id === 'string' ? row.id : String(row.id || ''))

  if (!artifact) return res.status(404).json({ error: 'Not found' })

  const resolved = assertArtifactPathIsSafe({ applicationId: row.id, storagePath: artifact.storage_path })
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File missing' })

  const ext = path.extname(resolved).toLowerCase()
  const contentType =
    ext === '.zip'
      ? 'application/zip'
      : ext === '.pdf'
        ? 'application/pdf'
        : ext === '.docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream'

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="application_${row.id}_${artifact.id}${ext || ''}"`)
  const stream = fs.createReadStream(resolved)
stream.on('error', (err) => {
  routeLogger.error('[applications] artifact stream error', { artifactId: req.params.artifactId, err })
  if (!res.headersSent) {
    res.status(500).json({ error: 'File read error' })
  }
})
stream.pipe(res)
})

export default router

