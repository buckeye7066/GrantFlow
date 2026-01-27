import express from 'express'
import fs from 'fs'
import path from 'path'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  requireAuthenticatedUser,
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

const router = express.Router()

async function ensureApplicationAccess(req, res, applicationId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null

  const row = await req.db.prepare('SELECT * FROM applications WHERE id = ?').get(String(applicationId))
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return null
  }

  const grant = await ensureGrantAccess(req, res, String(row.grant_id))
  if (!grant) return null

  // Extra safety: ensure org access (grant access should already imply this).
  if (row.organization_id) {
    const ok = await ensureOrganizationAccess(req, res, String(row.organization_id))
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

  const grant = await ensureGrantAccess(req, res, String(grantId))
  if (!grant) return

  const okOrg = await ensureOrganizationAccess(req, res, String(organizationId))
  if (!okOrg) return

  const userId = req.ctx?.userId ?? getAuthUserId(user)
  const app = await prepareApplication({
    db: req.db,
    grantId: String(grantId),
    organizationId: String(organizationId),
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
    sectionKey: String(req.params.sectionKey),
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
    key: String(req.params.key),
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
  const { method, metadata } = req.body ?? {}
  const updated = await markSubmitted({ db: req.db, applicationId: row.id, method, metadata })
  return res.json({ ok: true, application: updated })
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
    .get(String(req.params.artifactId), String(row.id))

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
  return fs.createReadStream(resolved).pipe(res)
})

export default router

