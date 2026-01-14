import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { createOpenAIClient } from '../utils/openaiClient.js';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import fetch from 'node-fetch';
import { extractTextFromFile } from '../services/documentTextExtraction.js';

// OpenAI client helper
function getOpenAI() {
  return createOpenAIClient().openai;
}

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

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/rtf',
  'text/rtf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

function multerFileFilter(_req, file, cb) {
  // Allow empty mimetype if extension suggests a supported type.
  const extension = (file?.originalname?.split('.').pop() || '').toLowerCase();
  const allowedExt = new Set([
    'pdf',
    'doc',
    'docx',
    'txt',
    'rtf',
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'bmp',
    'tif',
    'tiff',
    'heic',
    'heif',
  ]);
  const ok = ALLOWED_MIME_TYPES.has(file.mimetype) || allowedExt.has(extension);
  if (!ok) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file?.fieldname || 'file'));
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: multerFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB to match UI
});

// Rate limiter for file uploads to prevent abuse
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Max 20 uploads per 15 minutes per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many file uploads from this IP, please try again later.',
});

function respondMulterError(res, err) {
  if (!err) return false;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File is too large. Max size is 50MB.' });
      return true;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        error: 'Unsupported file type. Upload PDF, DOC/DOCX, TXT/RTF, or an image (JPG/PNG/WebP).',
      });
      return true;
    }
  }
  res.status(400).json({ error: err?.message || 'Upload failed' });
  return true;
}

function runUploadSingle(fieldName) {
  const middleware = upload.single(fieldName);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (err) return respondMulterError(res, err);
      return next();
    });
  };
}

async function downloadRemoteFileToUploads({ url, req }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Unable to download file (${resp.status})`);
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const contentLength = Number(resp.headers.get('content-length') || '0');
    if (contentLength && contentLength > 50 * 1024 * 1024) {
      throw new Error('Remote file is too large (max 50MB).');
    }

    const fileNameFromUrl = (() => {
      try {
        const parsed = new URL(url);
        const base = parsed.pathname.split('/').pop() || 'remote-upload';
        return base;
      } catch {
        return 'remote-upload';
      }
    })();

    // Use multer storage logic for filename uniqueness.
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const extension = fileNameFromUrl.includes('.') ? `.${fileNameFromUrl.split('.').pop()}` : '';
    const filename = `${unique}${extension}`;
    const absPath = join(uploadDir, filename);

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error('Remote file is too large (max 50MB).');
    }
    await fs.promises.writeFile(absPath, buf);

    const publicUrl = `/uploads/${filename}`;
    return {
      file: {
        path: absPath,
        size: buf.length,
        mimetype: contentType,
        originalname: fileNameFromUrl,
        filename,
      },
      publicUrl,
      source: { downloaded: true, url, contentType },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildAccessContext(req) {
  const user = req.user ?? { role: 'guest' };
  const isAdmin = user.role === 'admin';
  const accessibleProfiles = new Set();

  if (!isAdmin) {
    if (user.profileId) {
      accessibleProfiles.add(user.profileId);
    }
    if (user.userId) {
      const rows = await req.db
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

function ensureProfileAccess(res, context, profileId) {
  if (!profileId) {
    res.status(400).json({ error: 'profile_id is required' });
    return false;
  }
  if (context.isAdmin) {
    return true;
  }
  if (context.accessibleProfiles.has(profileId)) {
    return true;
  }
  res.status(403).json({ error: 'Not authorized for this profile' });
  return false;
}

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
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

    res.json(await req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const doc = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, doc)) return;
    
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/upload (Base44 Compatibility)
router.post('/upload', uploadLimiter, runUploadSingle('file'), async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (error) {
          // Best-effort cleanup; ignore unlink errors.
        }
      }
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
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        // Best-effort cleanup; ignore unlink errors.
      }
    }
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
router.post('/ingest', uploadLimiter, runUploadSingle('document'), async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkError) {
          // Best-effort cleanup; ignore unlink errors.
        }
      }
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

    let file = req.file;
    let fileUrl = req.body?.file_url ?? null;
    if (!file && fileUrl && (String(fileUrl).startsWith('http://') || String(fileUrl).startsWith('https://'))) {
      const downloaded = await downloadRemoteFileToUploads({ url: String(fileUrl), req });
      file = downloaded.file;
      fileUrl = downloaded.publicUrl;
    }

    if (!file && !rawExtractedText && !fileUrl) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const profileId = normalizeProfileId(rawProfileId);
    let resolvedOrganizationId = rawOrganizationId ?? null;

    if (profileId) {
      const profile = await req.db.prepare('SELECT id, organization_id FROM profiles WHERE id = ?').get(profileId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!context.isAdmin && !context.accessibleProfiles.has(profile.id)) {
        return res.status(403).json({ error: 'Not authorized for this profile' });
      }
      resolvedOrganizationId = profile.organization_id ?? null;
    }

    const docId = crypto.randomUUID();
    const publicUrl = file ? (fileUrl || `/uploads/${file.filename}`) : fileUrl;
    const docName = (file?.originalname || rawName || 'Uploaded Document').trim();
    
    let extractedText = rawExtractedText || null;
    if (!extractedText && file) {
      const ocr = req.body?.ocr === 'true' || req.body?.ocr === true;
      const ocrLanguage = req.body?.ocr_language || 'eng';
      const result = await extractTextFromFile({
        filePath: file.path,
        mimeType: file.mimetype,
        fileName: file.originalname,
        ocr,
        ocrLanguage,
      });
      extractedText = result?.text ?? null;
    }

    const skipParsing = rawSkipParsing === 'true' || rawSkipParsing === true;
    const processingStatus = skipParsing || extractedText ? 'completed' : 'pending';

    // Fixed SQL parameters
    await req.db.prepare(`
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
      await req.db
        .prepare(
          `
            INSERT INTO profile_documents (profile_id, document_id)
            VALUES (?, ?)
            ON CONFLICT DO NOTHING
          `,
        )
        .run(profileId, docId);
      await linkProfileToAdmin(req.db, profileId);
    }

    if (!skipParsing) {
      const requestedBy = context.user?.profileId ?? context.user?.userId ?? 'system';
      const jobId = crypto.randomUUID();
      await req.db
        .prepare(`
          INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
          VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
        `)
        .run(jobId, profileId, resolvedOrganizationId, JSON.stringify({ document_id: docId, source }), requestedBy);
      
      // Dispatch the job immediately
      const parseJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId);
      if (parseJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: parseJob.id,
          uploadDir,
          getOpenAI,
        });
      }
    }

    res.status(202).json({
      success: true,
      id: docId,
      profile_id: profileId,
      processing_status: processingStatus
    });
  } catch (error) {
    console.error('Ingest failed:', error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        // Best-effort cleanup; ignore unlink errors.
      }
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/documents/:id
router.put('/:id', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const existing = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, existing)) return;

    const fields = Object.keys(req.body ?? {});
    if (fields.length === 0) return res.status(400).json({ error: 'No fields provided' });

    const values = Object.values(req.body);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    await req.db.prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    res.json(await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const existing = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, existing)) return;

    await req.db.prepare('DELETE FROM profile_documents WHERE document_id = ?').run(req.params.id);
    await req.db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/:id/parse
// Queue AI parsing for a single document (creates a document_ingest crawler job).
router.post('/:id/parse', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const document = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, document)) return;

    const profileId = normalizeProfileId(document.profile_id);
    const requestedBy = context.user?.profileId ?? context.user?.userId ?? 'system';

    // De-dupe: if there's already a queued/running ingest job for this document, don't create another.
    const existing = await req.db
      .prepare(
        `
          SELECT id, status
          FROM crawler_jobs
          WHERE type = 'document_ingest'
            AND (status = 'queued' OR status = 'running')
            AND parameters LIKE ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(`%"document_id":"${document.id}"%`);

    if (!existing) {
      const jobId = crypto.randomUUID();
      await req.db
        .prepare(
          `
            INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
            VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
          `,
        )
        .run(
          jobId,
          profileId,
          document.organization_id ?? null,
          JSON.stringify({ document_id: document.id, source: 'manual_parse' }),
          requestedBy,
        );

      // Dispatch the job immediately
      const parseJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId);
      if (parseJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: parseJob.id,
          uploadDir,
          getOpenAI,
        });
      }

      // Mark document as pending/processing to surface UI state change immediately.
      await req.db
        .prepare(
          `
            UPDATE documents
            SET processing_status = CASE
              WHEN processing_status = 'completed' THEN 'pending'
              ELSE processing_status
            END
            WHERE id = ?
          `,
        )
        .run(document.id);
    }

    res.json({ success: true, queued: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/parse-all
// Queue parsing for recent documents on a profile.
router.post('/parse-all', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const profileId = normalizeProfileId(req.body?.profile_id);
    if (!ensureProfileAccess(res, context, profileId)) return;

    const requestedBy = context.user?.profileId ?? context.user?.userId ?? 'system';

    const docs = await req.db
      .prepare(
        `
          SELECT d.*
          FROM documents d
          WHERE d.profile_id = ?
          ORDER BY d.created_at DESC
          LIMIT 25
        `,
      )
      .all(profileId);

    let queued = 0;

    const insertJob = req.db.prepare(
      `
        INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
        VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
      `,
    );

    const jobsToDispatch = [];
    
    for (const doc of docs) {
      const already = await req.db
        .prepare(
          `
            SELECT 1
            FROM crawler_jobs
            WHERE type = 'document_ingest'
              AND (status = 'queued' OR status = 'running')
              AND parameters LIKE ?
            LIMIT 1
          `,
        )
        .get(`%"document_id":"${doc.id}"%`);

      if (already) continue;

      const jobId = crypto.randomUUID();
      await insertJob.run(
        jobId,
        profileId,
        doc.organization_id ?? null,
        JSON.stringify({ document_id: doc.id, source: 'parse_all' }),
        requestedBy,
      );
      
      jobsToDispatch.push(jobId);
      queued += 1;
    }
    
    // Dispatch all jobs (fire and forget)
    for (const jobId of jobsToDispatch) {
      dispatchCrawlerJob({
        db: req.db,
        jobId,
        uploadDir,
        getOpenAI,
      });
    }

    res.json({ success: true, queued_count: queued, document_count: docs.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
