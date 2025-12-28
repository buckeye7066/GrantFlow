import express from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import {
  getProfileById,
  getDocumentById,
  getDocumentsByProfileId,
  createDocument,
  updateDocument,
  deleteDocument,
} from '../db/index.js'
import parseDocument from '../parser/index.js'
import applyPatches from '../parser/patch/applyPatches.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

// Rate limiter for upload endpoints
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 uploads per window
  message: 'Too many uploads from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/jpg',
      'image/png',
    ]
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`File type ${file.mimetype} not supported`))
    }
  },
})

/**
 * POST /api/profiles/:profileId/documents
 * Upload document for a profile
 */
router.post('/:profileId/documents', uploadLimiter, upload.single('file'), async (req, res, next) => {
  try {
    const { profileId } = req.params
    
    // Verify profile exists
    const profile = getProfileById(profileId)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }
    
    const documentId = uuidv4()
    const file = req.file
    
    // Calculate SHA256 hash
    const hash = crypto.createHash('sha256')
    hash.update(file.buffer)
    const sha256 = hash.digest('hex')
    
    // Create storage path
    const storageDir = path.resolve(__dirname, '../storage/profiles', profileId, documentId)
    await fs.mkdir(storageDir, { recursive: true })
    
    const storagePath = path.join(storageDir, file.originalname)
    await fs.writeFile(storagePath, file.buffer)
    
    // Set file permissions (read/write for owner only) - Unix/Linux only
    try {
      await fs.chmod(storagePath, 0o600)
    } catch (error) {
      // chmod may not work on all platforms (e.g., Windows)
      console.warn('Failed to set file permissions:', error.message)
    }
    
    // Create document record
    const document = createDocument({
      id: documentId,
      profile_id: profileId,
      original_filename: file.originalname,
      mime_type: file.mimetype,
      storage_path: storagePath,
      sha256,
      size_bytes: file.size,
      status: 'uploaded',
    })
    
    // Parse document asynchronously
    setImmediate(async () => {
      try {
        updateDocument(documentId, { status: 'parsing' })
        
        const parseResult = await parseDocument(file.buffer, {
          originalFilename: file.originalname,
          mimeType: file.mimetype,
        })
        
        if (parseResult.error) {
          updateDocument(documentId, {
            status: 'failed',
            error: parseResult.error,
          })
        } else {
          updateDocument(documentId, {
            status: 'parsed',
            doc_type: parseResult.docType,
            extracted_json: JSON.stringify({
              text: parseResult.text,
              classification: parseResult.classification,
              extracted: parseResult.extracted,
            }),
            suggested_patches_json: JSON.stringify(parseResult.patches),
          })
        }
      } catch (error) {
        console.error('Error parsing document:', error)
        updateDocument(documentId, {
          status: 'failed',
          error: error.message,
        })
      }
    })
    
    res.status(201).json(document)
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/profiles/:profileId/documents
 * List documents for a profile
 */
router.get('/:profileId/documents', (req, res, next) => {
  try {
    const { profileId } = req.params
    const documents = getDocumentsByProfileId(profileId)
    res.json(documents)
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

/**
 * GET /api/documents/:documentId
 * Get document details including extraction
 */
router.get('/:documentId', (req, res, next) => {
  try {
    const { documentId } = req.params
    const document = getDocumentById(documentId)
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    // Parse JSON fields
    const response = {
      ...document,
      extracted: document.extracted_json ? JSON.parse(document.extracted_json) : null,
      suggested_patches: document.suggested_patches_json ? JSON.parse(document.suggested_patches_json) : null,
    }
    
    delete response.extracted_json
    delete response.suggested_patches_json
    
    res.json(response)
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

/**
 * POST /api/documents/:documentId/parse
 * Force re-parse document
 */
router.post('/:documentId/parse', async (req, res, next) => {
  try {
    const { documentId } = req.params
    const document = getDocumentById(documentId)
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    // Read file from storage
    const fileBuffer = await fs.readFile(document.storage_path)
    
    updateDocument(documentId, { status: 'parsing' })
    
    const parseResult = await parseDocument(fileBuffer, {
      originalFilename: document.original_filename,
      mimeType: document.mime_type,
    })
    
    if (parseResult.error) {
      updateDocument(documentId, {
        status: 'failed',
        error: parseResult.error,
      })
    } else {
      updateDocument(documentId, {
        status: 'parsed',
        doc_type: parseResult.docType,
        extracted_json: JSON.stringify({
          text: parseResult.text,
          classification: parseResult.classification,
          extracted: parseResult.extracted,
        }),
        suggested_patches_json: JSON.stringify(parseResult.patches),
      })
    }
    
    const updatedDoc = getDocumentById(documentId)
    res.json(updatedDoc)
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

/**
 * POST /api/documents/:documentId/apply
 * Apply extracted patches to profile/funding_sources
 */
router.post('/:documentId/apply', async (req, res, next) => {
  try {
    const { documentId } = req.params
    const document = getDocumentById(documentId)
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    if (!document.suggested_patches_json) {
      return res.status(400).json({ error: 'No patches available for this document' })
    }
    
    const patches = JSON.parse(document.suggested_patches_json)
    
    const changes = await applyPatches(patches, documentId, document.profile_id)
    
    updateDocument(documentId, {
      status: 'applied',
      applied_at: new Date().toISOString(),
    })
    
    res.json({
      message: 'Patches applied successfully',
      changes,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /api/documents/:documentId
 * Delete document (both DB record and file)
 */
router.delete('/:documentId', async (req, res, next) => {
  try {
    const { documentId } = req.params
    const document = getDocumentById(documentId)
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    // Delete file from storage
    try {
      await fs.unlink(document.storage_path)
      // Try to remove empty directories
      const docDir = path.dirname(document.storage_path)
      await fs.rmdir(docDir).catch(() => {})
    } catch (error) {
      console.error('Error deleting file:', error)
    }
    
    // Delete DB record
    deleteDocument(documentId)
    
    res.status(204).send()
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
