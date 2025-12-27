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
  } catch (error) {
    next(error)
  }
})

export default router
