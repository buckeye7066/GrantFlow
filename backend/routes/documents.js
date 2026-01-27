import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import net from 'net';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { createOpenAIClient } from '../utils/openaiClient.js';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import fetch from 'node-fetch';
import { classifyUniversityApplicationForDocument, loadUniversityApplicationsForProfile } from '../services/universityDocumentClassifier.js';
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { detectFileType } from '../services/documentIngestion/index.js'
import { ensureDocumentExtract } from '../services/documentIngestion/documentExtractStore.js'

// OpenAI client helper
function getOpenAI() {
  return createOpenAIClient().openai;
}

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Uploads must live on a persistent volume in production (Railway Volume).
// Keep this aligned with backend/server.js static `/uploads` serving.
const uploadDir = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, '..', 'uploads');

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

function isPrivateIpAddress(ip) {
  // IPv4 private ranges: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6 loopback/link-local/ULA
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    return false;
  }

  return true;
}

function assertRemoteUrlAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }

  const hostname = (parsed.hostname || '').toLowerCase().trim();
  if (!hostname) throw new Error('Invalid URL host');
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
    throw new Error('URL host is not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error('URL host is not allowed');
    }
  }

  return parsed;
}

async function downloadRemoteFileToUploads({ url, req }) {
  // Prevent obvious SSRF targets. (We intentionally do not resolve DNS here.)
  const initial = assertRemoteUrlAllowed(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(initial.toString(), { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Unable to download file (${resp.status})`);
    }
    // If redirects occurred, validate the final URL too.
    try {
      if (resp.url) {
        assertRemoteUrlAllowed(resp.url);
      }
    } catch {
      throw new Error('Final URL host is not allowed');
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
  const ctx = req.ctx ?? {
    userId: null,
    email: null,
    isAdmin: false,
    activeProfileId: null,
    accessibleProfileIds: new Set(),
  }

  const isAdmin = Boolean(ctx.isAdmin)
  const accessibleProfiles =
    isAdmin ? new Set() : ctx.accessibleProfileIds instanceof Set ? ctx.accessibleProfileIds : new Set()

  return { ctx, isAdmin, accessibleProfiles }
}

function ensureAuthenticated(res, context) {
  if (!context.ctx?.userId) {
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

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
      university_application_id,
      type,
      status,
      processing_status,
    } = req.query ?? {};

    const normalizedProfileId = normalizeProfileId(rawProfileId);
    const filters = [];
    const params = [];

    if (organization_id) { filters.push('organization_id = ?'); params.push(organization_id); }
    if (grant_id) { filters.push('grant_id = ?'); params.push(grant_id); }
    if (university_application_id) { filters.push('university_application_id = ?'); params.push(university_application_id); }
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
      university_application_id: rawUniversityApplicationId,
      university_application_name: rawUniversityApplicationName,
      extracted_text: rawExtractedText,
      notes: rawNotes,
      source = null,
      skip_parsing: rawSkipParsing,
      enable_ai: rawEnableAi,
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
    let universityApplicationId = rawUniversityApplicationId ? String(rawUniversityApplicationId).trim() : null;
    let universityApplicationName = rawUniversityApplicationName
      ? String(rawUniversityApplicationName).trim()
      : null;
    
    let extractedText = rawExtractedText || null;
    // IMPORTANT: Text extraction (including OCR) is async and handled by the `document_ingest` worker.

    const hasEnableAiField = rawEnableAi !== undefined;
    const hasSkipParsingField = rawSkipParsing !== undefined;
    const enableAiRequested = rawEnableAi === 'true' || rawEnableAi === true;
    const skipParsingRequested = rawSkipParsing === 'true' || rawSkipParsing === true;

    // DOCUMENT_AI gating is enforced only when AI-dependent parsing is requested.
    // Baseline ingest (upload + text extraction) is allowed for all tiers by default.
    const shouldRunAi =
      hasEnableAiField
        ? enableAiRequested && !skipParsingRequested
        : hasSkipParsingField
          ? !skipParsingRequested
          : context.isAdmin
            ? true
            : false;

    const skipParsing = !shouldRunAi;
    const processingStatus = extractedText ? 'completed' : 'pending';

    // Auto-classify to a university application when possible (if caller didn't specify one).
    if (profileId && !universityApplicationId && extractedText) {
      try {
        const applications = await loadUniversityApplicationsForProfile(req.db, profileId);
        const match = classifyUniversityApplicationForDocument({
          applications,
          documentName: docName,
          extractedText,
        });
        if (match) {
          universityApplicationId = match.id;
          universityApplicationName = match.name;
        }
      } catch (error) {
        // Best effort only; ignore classifier errors.
      }
    }

    // IMPORTANT: Do NOT set documents.status on insert.
    // Some deployments have legacy bad status values; status is constrained in Postgres.
    // We'll rely on the DB default and allow later updates to set status if needed.
    const insertDocumentSql = `
      INSERT INTO documents (
        id, organization_id, grant_id, profile_id, university_application_id, university_application_name, name, type,
        file_url, file_path, file_size, mime_type,
        extracted_text, processing_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const insertDocumentArgs = [
      docId,
      resolvedOrganizationId,
      rawGrantId || null,
      profileId,
      universityApplicationId,
      universityApplicationName,
      docName,
      rawType || null,
      publicUrl,
      file?.path || null,
      file?.size || null,
      file?.mimetype || null,
      extractedText,
      processingStatus,
      rawNotes || null,
    ]

    try {
      await req.db.prepare(insertDocumentSql).run(...insertDocumentArgs)
    } catch (error) {
      const msg = String(error?.message || error)
      // Safety retry: if an old code path still attempted to set status (or the DB has a legacy constraint edge),
      // retry the insert without status. (This statement already omits status.)
      if (msg.includes('documents_status_check')) {
        await req.db.prepare(insertDocumentSql).run(...insertDocumentArgs)
      } else {
        throw error
      }
    }

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

    // Create the canonical DocumentExtract row immediately (async worker fills it in).
    if (!extractedText && file?.path) {
      try {
        const detected = detectFileType({
          filePath: file.path,
          mimeType: file.mimetype,
          fileName: file.originalname,
        })
        await ensureDocumentExtract(req.db, {
          documentId: docId,
          sourceType: detected.source_type,
          fileHash: null,
        })
      } catch {
        // Best-effort: if migrations aren't applied yet, ingestion still succeeds.
      }
    }

    // Queue background ingestion:
    // - always extracts text (PDF/DOCX/TXT)
    // - OCR fallback for scanned PDFs + images
    // - AI parsing runs only if enable_ai is true (tier-gated)
    if (!extractedText && file?.path) {
      if (!skipParsing && profileId) {
        if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.DOCUMENT_AI))) return
      }

      const requestedBy = context.ctx?.userId ?? context.ctx?.activeProfileId ?? 'system';
      const jobId = crypto.randomUUID();
      await req.db
        .prepare(`
          INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
          VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
        `)
        .run(
          jobId,
          profileId,
          resolvedOrganizationId,
          JSON.stringify({
            document_id: docId,
            source,
            handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
            enable_ai: !skipParsing,
          }),
          requestedBy,
        );
      
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
      processing_status: processingStatus,
      enable_ai: !skipParsing,
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
    const requestedBy = context.ctx?.userId ?? context.ctx?.activeProfileId ?? 'system';

    if (profileId) {
      if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.DOCUMENT_AI))) return
    }

    // De-dupe: if there's already a queued/running ingest job for this document, don't create another.
    const existing = await req.db
      .prepare(
        `
          SELECT id, status, parameters
          FROM crawler_jobs
          WHERE type = 'document_ingest'
            AND (status = 'queued' OR status = 'running')
            AND parameters LIKE ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(`%"document_id":"${document.id}"%`);

    if (existing) {
      const params = safeJsonParse(existing.parameters, {}) || {}
      if (params.enable_ai !== true) {
        // If the job is already running, queue a follow-up parse job; otherwise upgrade in-place.
        if (existing.status === 'running') {
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
              JSON.stringify({
                document_id: document.id,
                source: 'manual_parse_followup',
                handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
                enable_ai: true,
              }),
              requestedBy,
            );
          const parseJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId);
          if (parseJob) {
            dispatchCrawlerJob({
              db: req.db,
              jobId: parseJob.id,
              uploadDir,
              getOpenAI,
            });
          }
        } else {
          params.enable_ai = true
          params.handwriting = req.body?.handwriting === 'true' || req.body?.handwriting === true
          await req.db
            .prepare('UPDATE crawler_jobs SET parameters = ? WHERE id = ?')
            .run(JSON.stringify(params), existing.id)
        }
      }
    } else {
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
          JSON.stringify({
            document_id: document.id,
            source: 'manual_parse',
            handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
            enable_ai: true,
          }),
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

    if (profileId) {
      if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.DOCUMENT_AI))) return
    }

    const requestedBy = context.ctx?.userId ?? context.ctx?.activeProfileId ?? 'system';

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
            SELECT id, status, parameters
            FROM crawler_jobs
            WHERE type = 'document_ingest'
              AND (status = 'queued' OR status = 'running')
              AND parameters LIKE ?
            LIMIT 1
          `,
        )
        .get(`%"document_id":"${doc.id}"%`);

      if (already) {
        const params = safeJsonParse(already.parameters, {}) || {}
        if (params.enable_ai !== true) {
          if (already.status === 'running') {
            const jobId = crypto.randomUUID();
            await insertJob.run(
              jobId,
              profileId,
              doc.organization_id ?? null,
              JSON.stringify({
                document_id: doc.id,
                source: 'parse_all_followup',
                handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
                enable_ai: true,
              }),
              requestedBy,
            );
            jobsToDispatch.push(jobId);
            queued += 1;
          } else {
            params.enable_ai = true
            params.handwriting = req.body?.handwriting === 'true' || req.body?.handwriting === true
            await req.db
              .prepare('UPDATE crawler_jobs SET parameters = ? WHERE id = ?')
              .run(JSON.stringify(params), already.id)
            queued += 1
          }
        }
        continue;
      }

      const jobId = crypto.randomUUID();
      await insertJob.run(
        jobId,
        profileId,
        doc.organization_id ?? null,
        JSON.stringify({
          document_id: doc.id,
          source: 'parse_all',
          handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
          enable_ai: true,
        }),
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

// POST /api/documents/:id/ingest
// Kick off extraction (and only extraction) for a document if not started.
router.post('/:id/ingest', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const document = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, document)) return;

    const profileId = normalizeProfileId(document.profile_id);
    const requestedBy = context.ctx?.userId ?? context.ctx?.activeProfileId ?? 'system';

    // If there's already a queued/running ingest job, leave it alone (it will do extraction).
    const existing = await req.db
      .prepare(
        `
          SELECT id
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
          JSON.stringify({
            document_id: document.id,
            source: 'manual_ingest',
            handwriting: req.body?.handwriting === 'true' || req.body?.handwriting === true,
            enable_ai: false,
          }),
          requestedBy,
        );

      const ingestJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId);
      if (ingestJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: ingestJob.id,
          uploadDir,
          getOpenAI,
        });
      }
    }

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

    res.json({ success: true, queued: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id/extract
// Returns extraction status + confidence meter (no full text payload).
router.get('/:id/extract', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const document = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, document)) return;

    const extract = await req.db
      .prepare('SELECT * FROM document_extracts WHERE document_id = ? LIMIT 1')
      .get(document.id);

    if (!extract) {
      return res.json({
        document_id: document.id,
        status: 'pending',
        confidence: 0,
        warnings: ['Extraction not started yet.'],
        char_count: 0,
        word_count: 0,
        pages: null,
        ocr_used: false,
        methods_used: [],
      });
    }

    const warnings = safeJsonParse(extract.warnings, []) ?? [];
    const methods = safeJsonParse(extract.methods_used, []) ?? [];

    res.json({
      id: extract.id,
      document_id: extract.document_id,
      status: extract.status,
      source_type: extract.source_type,
      methods_used: methods,
      pages: extract.pages ?? null,
      char_count: extract.char_count ?? 0,
      word_count: extract.word_count ?? 0,
      warnings,
      confidence: extract.confidence ?? 0,
      ocr_used: Boolean(extract.ocr_used),
      started_at: extract.started_at ?? null,
      finished_at: extract.finished_at ?? null,
      updated_at: extract.updated_at ?? null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id/extract/text
router.get('/:id/extract/text', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const document = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, document)) return;

    const extract = await req.db
      .prepare('SELECT status, text, confidence, warnings FROM document_extracts WHERE document_id = ? LIMIT 1')
      .get(document.id);

    if (!extract) return res.status(404).json({ error: 'No extraction record found' });
    if (extract.status !== 'ready') {
      return res.status(409).json({ error: 'Extraction not ready', status: extract.status });
    }

    res.json({
      document_id: document.id,
      status: extract.status,
      confidence: extract.confidence ?? 0,
      text: extract.text ?? '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
