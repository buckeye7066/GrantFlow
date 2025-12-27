import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { promises as fs } from 'fs'
import { v4 as uuid } from 'uuid'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getDb } from '../db/index.js'
import { parseDocument } from '../parser/index.js'
import { applyDocumentPatches } from '../parser/patch/applyPatches.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const STORAGE_ROOT = path.resolve(__dirname, '..', 'storage', 'profiles')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const router = Router()

async function ensureProfileExists(db, profileId) {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
  if (!profile) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }
  return profile
}

function mapDocument(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    storage_path: row.storage_path,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    status: row.status,
    doc_type: row.doc_type,
    extracted_json: row.extracted_json ? JSON.parse(row.extracted_json) : null,
    suggested_patches_json: row.suggested_patches_json
      ? JSON.parse(row.suggested_patches_json)
      : null,
    applied_at: row.applied_at,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function resolveDb(res) {
  try {
    return getDb()
  } catch (error) {
    const status = error.status ?? 503
    res
      .status(status)
      .json({ error: error.message ?? 'Database unavailable. Install better-sqlite3 on the server.' })
    return null
  }
}

router.post(
  '/profiles/:profileId/documents',
  upload.single('file'),
  async (req, res, next) => {
    try {
      const { profileId } = req.params
      const file = req.file
      if (!file) {
        return res.status(400).json({ error: 'File is required' })
      }

      const db = resolveDb(res)
      if (!db) return
      await ensureProfileExists(db, profileId)

      const documentId = uuid()
      const timestamp = new Date().toISOString()
      const profileDir = path.join(STORAGE_ROOT, profileId, documentId)
      await fs.mkdir(profileDir, { recursive: true })
      const destination = path.join(profileDir, file.originalname)
      await fs.writeFile(destination, file.buffer)

      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
      const insert = db.prepare(
        `INSERT INTO documents (
          id, profile_id, original_filename, mime_type, storage_path, sha256,
          size_bytes, status, doc_type, created_at, updated_at
        ) VALUES (
          @id, @profile_id, @original_filename, @mime_type, @storage_path, @sha256,
          @size_bytes, @status, @doc_type, @created_at, @updated_at
        )`,
      )

      insert.run({
        id: documentId,
        profile_id: profileId,
        original_filename: file.originalname,
        mime_type: file.mimetype || 'application/octet-stream',
        storage_path: destination,
        sha256,
        size_bytes: file.size,
        status: 'uploaded',
        doc_type: 'unknown',
        created_at: timestamp,
        updated_at: timestamp,
      })

      const record = db
        .prepare('SELECT * FROM documents WHERE id = ?')
        .get(documentId)
      res.status(201).json({ data: mapDocument(record) })
    } catch (error) {
      next(error)
    }
  },
)

router.get('/profiles/:profileId/documents', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const rows = db
      .prepare('SELECT * FROM documents WHERE profile_id = ? ORDER BY datetime(created_at) DESC')
      .all(req.params.profileId)
    res.json({ data: rows.map(mapDocument) })
  } catch (error) {
    next(error)
  }
})

router.get('/documents/:documentId', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.documentId)
    if (!row) {
      return res.status(404).json({ error: 'Document not found' })
    }
    res.json({ data: mapDocument(row) })
  } catch (error) {
    next(error)
  }
})

router.post('/documents/:documentId/parse', async (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.documentId)
    if (!row) {
      return res.status(404).json({ error: 'Document not found' })
    }

    const parseResult = await parseDocument(row, db)
    const update = db.prepare(
      `UPDATE documents
       SET status = @status,
           doc_type = @doc_type,
           extracted_json = @extracted_json,
           suggested_patches_json = @suggested_patches_json,
           error = NULL,
           updated_at = @updated_at
       WHERE id = @id`,
    )
    update.run({
      id: row.id,
      status: 'parsed',
      doc_type: parseResult.docType,
      extracted_json: JSON.stringify(parseResult.extraction ?? {}),
      suggested_patches_json: JSON.stringify(parseResult.patches ?? {}),
      updated_at: new Date().toISOString(),
    })

    const refreshed = db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)
    res.json({ data: mapDocument(refreshed) })
  } catch (error) {
    next(error)
  }
})

router.post('/documents/:documentId/apply', async (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.documentId)
    if (!row) {
      return res.status(404).json({ error: 'Document not found' })
    }

    const patches =
      row.suggested_patches_json && row.suggested_patches_json.length
        ? JSON.parse(row.suggested_patches_json)
        : null

    if (!patches) {
      return res.status(400).json({ error: 'Document has no suggested patches to apply' })
    }

    await applyDocumentPatches(db, row.profile_id, patches)

    const update = db.prepare(
      `UPDATE documents
       SET status = 'applied',
           applied_at = @applied_at,
           updated_at = @updated_at,
           error = NULL
       WHERE id = @id`,
    )
    const now = new Date().toISOString()
    update.run({
      id: row.id,
      applied_at: now,
      updated_at: now,
    })

    const refreshed = db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)
    res.json({ data: mapDocument(refreshed) })
  } catch (error) {
    next(error)
  }
})

export default router
