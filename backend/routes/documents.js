import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import rateLimit from 'express-rate-limit';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadDir = join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const extension = file.originalname.includes('.') ? `.${file.originalname.split('.').pop()}` : '';
    cb(null, `${unique}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Rate limiter for file uploads to prevent abuse
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Max 20 uploads per 15 minutes per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many file uploads from this IP, please try again later.',
});

async function extractTextFromFile(filePath, mimeType) {
  if (!filePath || !mimeType) return null;

  try {
    if (mimeType === 'application/pdf') {
      const buffer = await fsp.readFile(filePath);
      const result = await pdfParse(buffer);
      const text = result?.text?.trim();
      return text && text.length > 0 ? text : null;
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const buffer = await fsp.readFile(filePath);
      const { value } = await mammoth.extractRawText({ buffer });
      const text = value?.trim();
      return text && text.length > 0 ? text : null;
    }

    if (mimeType === 'text/plain') {
      const buffer = await fsp.readFile(filePath, 'utf8');
      const text = buffer?.toString()?.trim();
      return text && text.length > 0 ? text : null;
    }
  } catch (error) {
    console.warn('Document text extraction failed', { filePath, mimeType, error });
  }

  return null;
}

function buildAccessContext(req) {
  const user = req.user ?? { role: 'guest' };
  const isAdmin = user.role === 'admin';
  const accessibleProfiles = new Set();

  if (!isAdmin) {
    if (user.profileId) {
      accessibleProfiles.add(user.profileId);
    }
    if (user.userId) {
      const rows = req.db
        .prepare('SELECT id FROM profiles WHERE user_id = ?')
        .all(user.userId);
      rows.forEach((row) => accessibleProfiles.add(row.id));
    }
  }

  return { user, isAdmin, accessibleProfiles };
}

function ensureAuthenticated(res, context) {
  if (!context.user || context.user.role === 'guest') {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

function ensureDocumentAccess(res, context, document) {
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return false;
  }
  if (context.isAdmin) {
    return true;
  }
  if (document.profile_id && context.accessibleProfiles.has(document.profile_id)) {
    return true;
  }
  res.status(403).json({ error: 'Not authorized for this document' });
  return false;
}

function normalizeProfileId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return null;
  return trimmed;
}

// GET /api/documents
router.get('/', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const {
      organization_id,
      grant_id,
      profile_id: rawProfileId,
      type,
      status,
      processing_status,
    } = req.query ?? {};

    const normalizedProfileId = normalizeProfileId(rawProfileId);
    const filters = [];
    const params = [];

    if (organization_id) { filters.push('organization_id = ?'); params.push(organization_id); }
    if (grant_id) { filters.push('grant_id = ?'); params.push(grant_id); }
    if (type) { filters.push('type = ?'); params.push(type); }
    if (status) { filters.push('status = ?'); params.push(status); }
    if (processing_status) { filters.push('processing_status = ?'); params.push(processing_status); }

    if (context.isAdmin) {
      if (normalizedProfileId) { filters.push('profile_id = ?'); params.push(normalizedProfileId); }
    } else {
      const accessible = Array.from(context.accessibleProfiles);
      if (accessible.length === 0) return res.json([]);
      
      if (normalizedProfileId) {
        if (!context.accessibleProfiles.has(normalizedProfileId)) return res.json([]);
        filters.push('profile_id = ?');
        params.push(normalizedProfileId);
      } else {
        const placeholders = accessible.map(() => '?').join(', ');
        filters.push(`profile_id IN (${placeholders})`);
        params.push(...accessible);
      }
    }

    let query = 'SELECT * FROM documents';
    if (filters.length > 0) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';

    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, doc)) return;
    
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/upload (Base44 Compatibility)
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return;
    }

    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const relativePath = `/uploads/${req.file.filename}`;
    const absoluteUrl = `${req.protocol}://${req.get('host')}${relativePath}`;

    res.status(201).json({
      success: true,
      file_url: absoluteUrl,
      file_uri: relativePath,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
    });
  } catch (error) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// POST /api/documents/signed-url (Base44 Compatibility)
router.post('/signed-url', (req, res) => {
  const { file_uri } = req.body ?? {};
  if (!file_uri) return res.status(400).json({ error: 'file_uri is required' });
  const signedUrl = file_uri.startsWith('http') ? file_uri : `${req.protocol}://${req.get('host')}${file_uri.startsWith('/') ? '' : '/'}${file_uri}`;
  res.json({ signed_url: signedUrl });
});

// POST /api/documents/ingest (Universal Ingest)
router.post('/ingest', upload.single('document'), async (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return;
    }

    const {
      profile_id: rawProfileId,
      organization_id: rawOrganizationId,
      grant_id: rawGrantId,
      name: rawName,
      type: rawType,
      extracted_text: rawExtractedText,
      notes: rawNotes,
      source = null,
      skip_parsing: rawSkipParsing,
    } = req.body ?? {};

    const file = req.file;
    if (!file && !rawExtractedText && !req.body?.file_url) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const profileId = normalizeProfileId(rawProfileId);
    let resolvedOrganizationId = rawOrganizationId ?? null;

    if (profileId) {
      const profile = req.db.prepare('SELECT id, organization_id FROM profiles WHERE id = ?').get(profileId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!context.isAdmin && !context.accessibleProfiles.has(profile.id)) {
        return res.status(403).json({ error: 'Not authorized for this profile' });
      }
      resolvedOrganizationId = profile.organization_id ?? null;
    }

    const docId = crypto.randomUUID();
    const publicUrl = file ? `/uploads/${file.filename}` : req.body?.file_url ?? null;
    const docName = (file?.originalname || rawName || 'Uploaded Document').trim();
    
    let extractedText = rawExtractedText || null;
    if (!extractedText && file) {
      extractedText = await extractTextFromFile(file.path, file.mimetype);
    }

    const skipParsing = rawSkipParsing === 'true' || rawSkipParsing === true;
    const processingStatus = skipParsing || extractedText ? 'completed' : 'pending';

    // Fixed SQL parameters
    req.db.prepare(`
      INSERT INTO documents (
        id, organization_id, grant_id, profile_id, name, type,
        file_url, file_path, file_size, mime_type, 
        extracted_text, processing_status, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      docId,
      resolvedOrganizationId,
      rawGrantId || null,
      profileId,
      docName,
      rawType || null,
      publicUrl,
      file?.path || null,
      file?.size || null,
      file?.mimetype || null,
      extractedText,
      processingStatus,
      rawNotes || null
    );

    if (profileId) {
      req.db.prepare('INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)').run(profileId, docId);
      linkProfileToAdmin(req.db, profileId);
    }

    if (!skipParsing) {
      const requestedBy = context.user?.profileId ?? context.user?.userId ?? 'system';
      req.db.prepare(`
        INSERT INTO crawler_jobs (type, status, profile_id, organization_id, parameters, requested_by)
        VALUES ('document_ingest', 'queued', ?, ?, ?, ?)
      `).run(profileId, resolvedOrganizationId, JSON.stringify({ document_id: docId, source }), requestedBy);
    }

    res.status(202).json({
      success: true,
      id: docId,
      profile_id: profileId,
      processing_status: processingStatus
    });
  } catch (error) {
    console.error('Ingest failed:', error);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/documents/:id
router.put('/:id', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const existing = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, existing)) return;

    const fields = Object.keys(req.body ?? {});
    if (fields.length === 0) return res.status(400).json({ error: 'No fields provided' });

    const values = Object.values(req.body);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    req.db.prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    res.json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const existing = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, existing)) return;

    req.db.prepare('DELETE FROM profile_documents WHERE document_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
