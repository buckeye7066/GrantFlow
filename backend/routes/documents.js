import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { createOpenAIClient } from '../utils/openaiClient.js';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import * as cheerio from 'cheerio';
import { classifyUniversityApplicationForDocument, loadUniversityApplicationsForProfile } from '../services/universityDocumentClassifier.js';
import { supportedSectionKeys } from '../prompts/profileSections.js'
import { ident } from '../utils/safeSql.js'
import { getDefaultSectionData } from '../config/profileSchema.js'
import { hasTierCapability, requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { detectFileType } from '../services/documentIngestion/index.js'
import { ensureDocumentExtract } from '../services/documentIngestion/documentExtractStore.js'
import { readValidatedUploadBytes } from '../services/durableDocumentBytes.js'
import { resolveUploadsDir } from '../utils/uploadsDir.js'
import { getTrustedUserEmails } from '../utils/accessControl.js'
import { fetchPublicResource, publicFetchFailureStatus } from '../utils/safeRemoteFetch.js'
import {
  UploadValidationError,
  validateUploadBufferSecure,
  validateUploadedFile,
} from '../utils/uploadFileValidation.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:documents')

// OpenAI client helper
function getOpenAI() {
  return createOpenAIClient().openai;
}

const router = express.Router();

// Metadata routes must never materialize durable receipt/document blobs. The
// derived marker preserves an authenticated download URL without selecting the
// bytes themselves (important when a scoped list contains multiple 10 MiB
// receipts).
const DOCUMENT_METADATA_SELECT = `
  id, created_at, updated_at,
  organization_id, grant_id, profile_id,
  university_application_id, university_application_name,
  name, type, file_url, file_path, file_size, mime_type,
  extracted_text, extracted_structured, ai_summary, ai_sections,
  processing_status, processing_error, status, version,
  vnext_application_id, storage_uri, content_hash, notes,
  CASE WHEN file_bytes IS NOT NULL AND length(file_bytes) > 0
       THEN 1 ELSE 0 END AS has_durable_bytes
`

// Require authentication for all document routes
router.use((req, res, next) => {
  if (!req.ctx?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function getUploadsDir(req) {
  const fromApp = req?.app?.locals?.uploads?.uploadsDir
  if (fromApp) return String(fromApp)
  if (req?.uploadsDir) return String(req.uploadsDir)
  const resolved = resolveUploadsDir({ baseDir: join(__dirname, '..') })
  return resolved.uploadsDir
}

function getLegacyUploadsDir(req) {
  const fromApp = req?.app?.locals?.uploads?.legacyUploadsDir
  if (fromApp) return String(fromApp)
  if (req?.legacyUploadsDir) return String(req.legacyUploadsDir)
  const resolved = resolveUploadsDir({ baseDir: join(__dirname, '..') })
  return resolved.legacyUploadsDir
}

function requireUploadsWritable(req, res, next) {
  const status = req?.storageStatus || req?.app?.locals?.uploads?.storageStatus || null
  if (status && status.writable === false) {
    return res.status(503).json({
      ok: false,
      error: 'Upload storage is unavailable',
      code: 'UPLOAD_STORAGE_UNAVAILABLE',
      uploads_dir: status.uploads_dir || null,
      status: status.status || 'degraded',
    })
  }
  return next()
}

function serializeDocument(doc) {
  if (!doc || !doc.id) return doc
  // Durable receipt/packet blobs belong only on the authenticated download
  // route. Never let SELECT * JSON responses serialize file_bytes.
  const { file_bytes: fileBytes, has_durable_bytes: hasDurableMarker, ...safe } = doc
  const hasDurableBytes = Boolean(hasDurableMarker) ||
    (Buffer.isBuffer(fileBytes) ? fileBytes.length > 0 : Boolean(fileBytes))
  const hasLocalFile = safe.file_path || (safe.file_url && String(safe.file_url).startsWith('/uploads/'))
  return (hasLocalFile || hasDurableBytes)
    ? { ...safe, download_url: `/api/documents/${String(safe.id)}/download` }
    : safe
}

async function manualSubmissionReceiptBinding(db, documentId) {
  if (!db || !documentId) return null
  try {
    return await db.prepare(
      `SELECT id, task_id, profile_id
         FROM hamilton_manual_submission_receipts
        WHERE document_id = ?
        LIMIT 1`,
    ).get(String(documentId))
  } catch (error) {
    const message = String(error?.message || '').toLowerCase()
    // Additive migration rollout: a missing table means this deployment cannot
    // yet hold a receipt binding. Other DB failures stay visible/fail closed.
    if (message.includes('no such table') || message.includes('does not exist')) return null
    throw error
  }
}

function applyPrivateDocumentDownloadHeaders(res, doc) {
  if (String(doc?.type || '') !== 'hamilton_submission_confirmation') return
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function attachmentContentDisposition(value) {
  // Node rejects non-Latin-1/control characters in header values. Document
  // names are user-visible Unicode, so emit a bounded ASCII fallback rather
  // than turning a valid authenticated download into a 500 response.
  const safeName = String(value || 'document')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/["\\/\r\n]/g, '_')
    .trim()
    .slice(0, 180) || 'document'
  return `attachment; filename="${safeName}"`
}

function extractUploadsFilenameFromUrl(rawUrl) {
  const raw = String(rawUrl || '').trim()
  if (!raw) return null

  let pathname = raw
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname
  } catch {
    pathname = raw
  }

  if (!pathname.includes('/uploads/')) return null
  const fileName = pathname.split('/uploads/').pop() || ''
  const baseName = fileName.split('/').pop() // defensive
  return baseName ? baseName.replace(/[^a-zA-Z0-9._-]/g, '') : null
}

function realServerOwnedUploadRoots(req) {
  const configured = [getUploadsDir(req), getLegacyUploadsDir(req)]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  const roots = []
  for (const configuredRoot of configured) {
    try {
      if (!isAbsolute(configuredRoot)) continue
      const rootPath = resolve(configuredRoot)
      const stat = fs.statSync(rootPath)
      if (!stat.isDirectory()) continue
      roots.push(fs.realpathSync(rootPath))
    } catch {
      // Missing/unresolvable roots are not safe download authorities.
    }
  }
  return [...new Set(roots)]
}

function resolveRegularUploadFile(candidate, roots) {
  const raw = String(candidate || '').trim()
  if (!raw || !isAbsolute(raw) || roots.length === 0) return null
  try {
    const requested = resolve(raw)
    const linkStat = fs.lstatSync(requested)
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) return null
    const realPath = fs.realpathSync(requested)
    const insideOwnedRoot = roots.some((root) => (
      realPath === root || realPath.startsWith(`${root}${sep}`)
    ))
    if (!insideOwnedRoot) return null
    if (!fs.statSync(realPath).isFile()) return null
    return realPath
  } catch {
    return null
  }
}

function resolveDocumentFilePath({ req, doc }) {
  const uploadsDir = getUploadsDir(req)
  const legacyUploadsDir = getLegacyUploadsDir(req)
  const roots = realServerOwnedUploadRoots(req)

  const tried = []

  const filePath = doc?.file_path ? String(doc.file_path) : ''
  if (filePath) {
    tried.push(filePath)
    const safePath = resolveRegularUploadFile(filePath, roots)
    if (safePath) return { ok: true, path: safePath, tried }
  }

  const fileName =
    extractUploadsFilenameFromUrl(doc?.file_url) ||
    extractUploadsFilenameFromUrl(doc?.file_uri) ||
    extractUploadsFilenameFromUrl(doc?.fileUrl) ||
    null

  if (fileName) {
    const primary = join(uploadsDir, fileName)
    tried.push(primary)
    const safePrimary = resolveRegularUploadFile(primary, roots)
    if (safePrimary) return { ok: true, path: safePrimary, tried }

    if (legacyUploadsDir && legacyUploadsDir !== uploadsDir) {
      const legacy = join(legacyUploadsDir, fileName)
      tried.push(legacy)
      const safeLegacy = resolveRegularUploadFile(legacy, roots)
      if (safeLegacy) return { ok: true, path: safeLegacy, tried }
    }
  }

  return { ok: false, tried }
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, getUploadsDir(req)),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    // The client-supplied originalname is untrusted. Taking the raw
    // "last dot-separated segment" as the extension lets a name with no dot
    // AFTER a slash (e.g. "x.tar/../../evil") smuggle "/" and ".." into the
    // generated filename, which multer then joins onto the uploads dir
    // (path injection). Strip everything but safe filename characters and
    // cap the length so the extension can never carry a path separator.
    const rawExtension = file.originalname.includes('.') ? file.originalname.split('.').pop() : '';
    const extension = rawExtension ? `.${String(rawExtension).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}` : '';
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
const ALLOWED_FILE_EXTENSIONS = new Set([
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

function multerFileFilter(_req, file, cb) {
  // Allow empty mimetype if extension suggests a supported type.
  const extension = (file?.originalname?.split('.').pop() || '').toLowerCase();
  const ok = ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_FILE_EXTENSIONS.has(extension);
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
    middleware(req, res, async (err) => {
      if (err) return respondMulterError(res, err);
      if (!req.file) return next();
      try {
        req.file.securityValidation = await validateUploadedFile(req.file)
        return next();
      } catch (validationError) {
        try {
          await fs.promises.unlink(req.file.path)
        } catch {
          // Best-effort quarantine cleanup. The request is rejected either way.
        }
        const status = validationError instanceof UploadValidationError
          ? validationError.statusCode
          : 415
        return res.status(status).json({
          ok: false,
          error: validationError?.message || 'The file type could not be verified.',
          code: validationError?.code || 'UPLOAD_SECURITY_VALIDATION_FAILED',
        })
      }
    });
  };
}

async function downloadRemoteFileToUploads({ url, req }) {
  const remote = await fetchPublicResource(url, {
    timeoutMs: 20_000,
    maxBytes: 50 * 1024 * 1024,
    allowedContentTypes: [
      ...ALLOWED_MIME_TYPES,
      'text/html',
      'application/xhtml+xml',
      'application/xml',
      'text/xml',
      'application/octet-stream',
    ],
    userAgent: 'Mozilla/5.0 (compatible; GrantFlow/1.0; +https://app.axiombiolabs.org)',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  if (!remote.ok) {
    const status = remote.status ? ` (${remote.status})` : '';
    const error = new Error(`Unable to download public HTTPS resource${status}: ${remote.reason}`);
    error.status = publicFetchFailureStatus(remote);
    error.code = `REMOTE_FETCH_${String(remote.reason || 'FAILED').toUpperCase()}`;
    throw error;
  }

  let contentType = remote.contentType || 'application/octet-stream';
  const buf = remote.body;
  if (contentType === 'application/octet-stream') {
    if (buf.length < 5 || buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
      const error = new Error('Remote server returned an unverified binary document type.');
      error.status = 415;
      error.code = 'REMOTE_DOCUMENT_TYPE_UNVERIFIED';
      throw error;
    }
    contentType = 'application/pdf';
  }

  const fileNameFromUrl = (() => {
    try {
      const parsed = new URL(remote.finalUrl || url);
      const base = parsed.pathname.split('/').pop() || 'remote-upload';
      return base;
    } catch {
      return 'remote-upload';
    }
  })();

  // Use multer storage logic for filename uniqueness.
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const candidateExtension = fileNameFromUrl.includes('.')
    ? fileNameFromUrl.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
  const safeExtension = ALLOWED_FILE_EXTENSIONS.has(candidateExtension)
    ? candidateExtension
    : contentType === 'application/pdf'
      ? 'pdf'
      : '';
  const extension = safeExtension ? `.${safeExtension}` : '';
  const filename = `${unique}${extension}`;
  // Validate filename to prevent directory traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }
  const absPath = join(getUploadsDir(req), filename);

  // Detect HTML content (webpage URL rather than direct file link)
  const ct = (contentType || '').toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  if (isHtml) {
    const html = buf.toString('utf-8');
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, iframe, noscript, svg').remove();
    const pageTitle = $('title').first().text().trim() || $('h1').first().text().trim() || '';
    let bodyText = '';
    const mainEl = $('main, article, [role="main"]').first();
    if (mainEl.length) {
      bodyText = mainEl.text();
    } else {
      bodyText = $('body').text();
    }
    const extractedText = bodyText.replace(/[ \t]+/g, ' ').replace(/(\n\s*){3,}/g, '\n\n').trim();
    if (!extractedText) {
      throw new Error('URL points to a webpage but no readable text could be extracted.');
    }
    return {
      file: null,
      publicUrl: null,
      htmlExtracted: true,
      extractedText,
      pageTitle: pageTitle || null,
      source: { downloaded: true, url, finalUrl: remote.finalUrl, contentType, isHtml: true },
    };
  }

  const hasExtension = Boolean(fileNameFromUrl.includes('.') && candidateExtension)
  const validationName = !hasExtension && contentType === 'application/pdf'
    ? `${fileNameFromUrl}.pdf`
    : fileNameFromUrl
  const securityValidation = await validateUploadBufferSecure({
    buffer: buf,
    originalName: validationName,
    mimetype: contentType,
  })

  await fs.promises.writeFile(absPath, buf);

  const publicUrl = `/uploads/${filename}`;
  return {
    file: {
      path: absPath,
      size: buf.length,
      mimetype: contentType,
      originalname: validationName,
      filename,
      securityValidation,
    },
    publicUrl,
    source: { downloaded: true, url, finalUrl: remote.finalUrl, contentType },
  };
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

function normalizeEmail(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v || !v.includes('@')) return null
  return v
}

export async function isProfileOwnerForDelete(req, { profileId, actorUserId, actorEmail }) {
  if (!profileId || !actorUserId) return false
  const row = await req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(String(profileId))
  const ownerUserId = row?.user_id ? String(row.user_id) : null

  // If the profile has an explicit owner, only that user can delete (unless admin).
  if (ownerUserId) {
    return ownerUserId === String(actorUserId)
  }

  // Legacy profiles may have NULL user_id. Ownership for a DESTRUCTIVE action is
  // proven ONLY by the profile's own identity email (basic_information.email) —
  // NOT by profile_emails, which is the SHARE allowlist: a collaborator merely
  // shared onto a legacy profile must NOT be able to delete its documents.
  const email = normalizeEmail(actorEmail)
  if (!email) return false

  // basic_information.email (the profile's owner-identity email) is the ONLY
  // legacy-owner proof. Never profile_emails (shares).
  try {
    if (req.db?.dialect === 'postgres') {
      const exists = await req.db
        .prepare(
          `
            SELECT 1
            FROM profile_sections
            WHERE profile_id = ?
              AND section_key = 'basic_information'
              AND LOWER((data::jsonb ->> 'email')) = ?
            LIMIT 1
          `,
        )
        .get(String(profileId), email)
      if (exists) return true
    } else {
      // SQLite: prefer json_extract when json1 is available, fall back to LIKE otherwise.
      try {
        const exists = await req.db
          .prepare(
            `
              SELECT 1
              FROM profile_sections
              WHERE profile_id = ?
                AND section_key = 'basic_information'
                AND LOWER(json_extract(data, '$.email')) = ?
              LIMIT 1
            `,
          )
          .get(String(profileId), email)
        if (exists) return true
      } catch {
        // json1 unavailable: parse the section JSON in JS and compare ONLY the
        // ROOT basic_information.email. A substring LIKE match would let a NESTED
        // contact email count as owner proof (a shared collaborator could then
        // delete). Fail closed on unparseable data.
        try {
          const secRow = await req.db
            .prepare(
              `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`,
            )
            .get(String(profileId))
          const parsed = secRow?.data
            ? JSON.parse(typeof secRow.data === 'string' ? secRow.data : String(secRow.data))
            : null
          const rootEmail = normalizeEmail(parsed && typeof parsed === 'object' ? parsed.email : null)
          if (rootEmail && rootEmail === email) return true
        } catch {
          // unparseable JSON → fail closed (no ownership)
        }
      }
    }
  } catch {
    // ignore (best-effort)
  }

  return false
}

async function ensureDocumentDeleteAccess(req, res, context, document) {
  if (context.isAdmin) return true
  const profileId = document?.profile_id ? String(document.profile_id) : null
  if (!profileId) {
    res.status(403).json({ error: 'Not authorized to delete this document' })
    return false
  }

  const actorUserId = context.ctx?.userId ?? null

  // NOTE: a matching ctx.activeProfileId is NOT ownership. activeProfileId is only
  // validated against the ACCESSIBLE set, which includes profiles merely SHARED to
  // the caller via profile_emails — so treating "active profile === document
  // profile" as ownership let a shared-profile user delete the OWNER's documents
  // (IDOR). Delete now requires owner-equivalent proof only: profiles.user_id ===
  // actorUserId, or a NULL-owner legacy profile whose saved email matches one of
  // the caller's DB-VERIFIED emails (both checked below).

  // Ownership via profiles.user_id (no email needed).
  if (await isProfileOwnerForDelete(req, { profileId, actorUserId, actorEmail: null })) return true

  // Legacy NULL-user_id ownership: a saved profile email counts as ownership only
  // when it matches one of the caller's DB-VERIFIED emails — NEVER the
  // token-supplied ctx.email/req.user.email (a JWT could claim victim@example.com
  // against a shared legacy profile and delete its documents).
  const trustedEmails = await getTrustedUserEmails(req.db, req.user)
  for (const actorEmail of trustedEmails) {
    if (await isProfileOwnerForDelete(req, { profileId, actorUserId, actorEmail })) return true
  }

  console.warn('[documents] delete denied', {
    document_id: document?.id ?? null,
    profile_id: profileId,
    actor_user_id: actorUserId,
  })
  res.status(403).json({ error: 'Not authorized to delete this document' })
  return false
}

function normalizeProfileId(value) {
  if ((value === null || value === undefined)) return null;
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
router.get('/', async (req, res, next) => {
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
      scope,
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

    // SECURITY:
    // We do NOT default to returning "all accessible profiles" documents when `profile_id` is omitted.
    // That can cause cross-profile leakage in UIs that forgot to pass the profile_id (as reported).
    //
    // - Default behavior: require profile_id (or infer it from X-Profile-Id if present).
    // - Escape hatch (admin-only): `?scope=all_accessible` returns across accessible profiles.
    const allowAllAccessible = String(scope || '').trim().toLowerCase() === 'all_accessible'

    // Best-effort fallback: if caller omitted profile_id but sent X-Profile-Id, scope to it.
    const headerProfileId = normalizeProfileId(req.headers?.['x-profile-id'] || req.headers?.['X-Profile-Id'])
    const effectiveProfileId = normalizedProfileId || headerProfileId || null

    if (allowAllAccessible) {
      if (!context.isAdmin) {
        return res.status(403).json({ error: 'Not authorized for all-accessible document listing' })
      }
      // Admin explicitly requested broad listing. Keep legacy behavior.
      const accessible = Array.from(context.accessibleProfiles || [])
      if (accessible.length > 0) {
        const placeholders = accessible.map(() => '?').join(', ')
        filters.push(`profile_id IN (${placeholders})`)
        params.push(...accessible)
      }
    } else {
      if (!effectiveProfileId) {
        // Contract (endpoint health): GET /api/documents must be 200-safe
        // when called without an explicit profile_id. We still avoid cross-
        // profile leakage by returning an empty array — the caller is telling
        // us it has no tenant context to scope against.
        return res.json([])
      }

      if (context.isAdmin) {
        filters.push('profile_id = ?')
        params.push(effectiveProfileId)
      } else {
        if (!context.accessibleProfiles.has(effectiveProfileId)) return res.json([])
        filters.push('profile_id = ?')
        params.push(effectiveProfileId)
      }
    }

    let query = `SELECT ${DOCUMENT_METADATA_SELECT} FROM documents`;
    if (filters.length > 0) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';

    const rows = await req.db.prepare(query).all(...params)
    res.json((rows || []).map(serializeDocument));
  } catch (error) {
    return next(error)
  }
});

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const context = await buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) return;

    const doc = await req.db
      .prepare(`SELECT ${DOCUMENT_METADATA_SELECT} FROM documents WHERE id = ?`)
      .get(req.params.id);
    if (!ensureDocumentAccess(res, context, doc)) return;
    
    res.json(serializeDocument(doc));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id/download
// Defensive: returns a clear 404 if the file is missing, with docId/profileId context.
router.get('/:id/download', async (req, res) => {
  try {
    const context = await buildAccessContext(req)
    if (!ensureAuthenticated(res, context)) return

    const doc = await req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id)
    if (!ensureDocumentAccess(res, context, doc)) return
    applyPrivateDocumentDownloadHeaders(res, doc)

    const resolved = resolveDocumentFilePath({ req, doc })
    if (!resolved.ok) {
      // Durable fallback: generated packets (and any doc stored via the BYTEA
      // pattern) keep their bytes in documents.file_bytes so a download still
      // works when the disk copy is gone (ephemeral fs / pruned temp). This is
      // also what lets us safely prune regenerable on-disk packet copies.
      if (doc?.file_bytes) {
        const buf = Buffer.isBuffer(doc.file_bytes) ? doc.file_bytes : Buffer.from(doc.file_bytes)
        if (buf.length > 0) {
          const fileName = String(doc?.file_name || doc?.name || '').trim() || 'document'
          const mimeType = String(doc?.mime_type || '').trim() || 'application/octet-stream'
          res.setHeader('Content-Type', mimeType)
          res.setHeader('Content-Disposition', attachmentContentDisposition(fileName))
          return res.send(buf)
        }
      }
      console.warn('[documents] missing file for download', {
        requestId: req.requestId || null,
        documentId: String(req.params.id),
        profileId: doc?.profile_id ?? null,
        file_path: doc?.file_path ?? null,
        file_url: doc?.file_url ?? null,
        tried: resolved.tried,
      })
      return res.status(404).json({
        ok: false,
        error: 'Document file not found',
        code: 'DOCUMENT_FILE_MISSING',
        document_id: String(req.params.id),
        profile_id: doc?.profile_id ?? null,
      })
    }

    const fileName = String(doc?.file_name || doc?.name || '').trim() || 'document'
    const mimeType = String(doc?.mime_type || '').trim() || 'application/octet-stream'
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', attachmentContentDisposition(fileName))
    return fs.createReadStream(resolved.path).pipe(res)
  } catch (error) {
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/documents/upload (Legacy Compatibility)
router.post('/upload', uploadLimiter, requireUploadsWritable, runUploadSingle('file'), async (req, res) => {
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

// POST /api/documents/signed-url (Legacy Compatibility)
router.post('/signed-url', (req, res) => {
  const { file_uri } = req.body ?? {};
  if (!file_uri) return res.status(400).json({ error: 'file_uri is required' });
  const signedUrl = file_uri.startsWith('http') ? file_uri : `${req.protocol}://${req.get('host')}${file_uri.startsWith('/') ? '' : '/'}${file_uri}`;
  res.json({ signed_url: signedUrl });
});

// POST /api/documents/ingest (Universal Ingest)
router.post('/ingest', uploadLimiter, requireUploadsWritable, runUploadSingle('document'), async (req, res) => {
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
      display_name: rawDisplayName,
      displayName: rawDisplayNameAlt,
      primary_type: rawPrimaryType,
      primaryType: rawPrimaryTypeAlt,
      university_application_id: rawUniversityApplicationId,
      university_application_name: rawUniversityApplicationName,
      extracted_text: rawExtractedText,
      notes: rawNotes,
      source = null,
      skip_parsing: rawSkipParsing,
      enable_ai: rawEnableAi,
      add_to_opportunities: rawAddToOpportunities,
    } = req.body ?? {};

    let file = req.file;
    let fileUrl = req.body?.file_url ?? null;
    let extractedTextFromHtml = null;
    let htmlPageTitle = null;

    // Auto-prepend https:// if no protocol specified
    if (fileUrl && !/^https?:\/\//i.test(String(fileUrl))) {
      fileUrl = `https://${String(fileUrl).trim()}`;
    }
    if (!file && fileUrl && (String(fileUrl).startsWith('http://') || String(fileUrl).startsWith('https://'))) {
      const downloaded = await downloadRemoteFileToUploads({ url: String(fileUrl), req });
      if (downloaded.htmlExtracted) {
        // URL pointed to a webpage, not a file
        extractedTextFromHtml = downloaded.extractedText;
        htmlPageTitle = downloaded.pageTitle || null;
        fileUrl = downloaded.source.finalUrl || downloaded.source.url || fileUrl;
      } else {
        file = downloaded.file;
        fileUrl = downloaded.publicUrl;
      }
    }

    if (!file && !rawExtractedText && !extractedTextFromHtml && !fileUrl) {
      return res.status(400).json({ error: 'document file is required' });
    }

    let profileId = normalizeProfileId(rawProfileId);
    let resolvedOrganizationId = rawOrganizationId ?? null;

    // If no profile_id is provided, create a new profile from this uploaded form.
    // This is the critical path for "Upload Form" on the Organizations page.
    if (!profileId) {
      const fromBody = rawDisplayName ?? rawDisplayNameAlt ?? null
      const fromFile =
        file?.originalname && typeof file.originalname === 'string'
          ? file.originalname.replace(/\.[^/.]+$/, '')
          : null
      const displayName = String(fromBody || fromFile || rawName || 'New Profile').trim()
      const primaryType = String(rawPrimaryType ?? rawPrimaryTypeAlt ?? 'individual').trim() || 'individual'

      const createdBy = context?.ctx?.userId ?? context?.ctx?.email ?? req?.ctx?.userId ?? req?.ctx?.email ?? null
      // IMPORTANT:
      // profiles.user_id is UNIQUE (one "owned" profile per user). Admin-created profiles should NOT
      // default to being "owned" by the admin user/token, or subsequent creates will 500.
      // Endusers can still own their single profile; additional access is via profile_emails.
      const userId = context?.isAdmin ? null : (context?.ctx?.userId ?? req?.ctx?.userId ?? null)
      const createdProfileId = crypto.randomUUID()

      await req.db.withTransaction(async (tx) => {
        await tx
          .prepare(
            `
              INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, user_id)
              VALUES (?, ?, ?, 'active', ?, ?, ?)
            `,
          )
          .run(createdProfileId, displayName, primaryType, JSON.stringify([]), createdBy, userId)

        // Ensure every profile has all canonical sections so downstream crawlers/matching never hit missing keys.
        const upsertSection = tx.prepare(
          `
            INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(profile_id, section_key) DO NOTHING
          `,
        )
        for (const sectionKey of supportedSectionKeys) {
          const defaults = getDefaultSectionData(sectionKey)
          await upsertSection.run(createdProfileId, sectionKey, JSON.stringify(defaults ?? {}), 'system-create')
        }
      })

      await linkProfileToAdmin(req.db, createdProfileId)
      profileId = createdProfileId

      routeLogger.info('[documents/ingest] created profile from upload', {
        requestId: req.requestId || null,
        profile_id: createdProfileId,
        display_name: displayName,
        primary_type: primaryType,
      })
    }

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
    const docName = (file?.originalname || rawName || htmlPageTitle || 'Uploaded Document').trim();
    let universityApplicationId = rawUniversityApplicationId ? String(rawUniversityApplicationId).trim() : null;
    let universityApplicationName = rawUniversityApplicationName
      ? String(rawUniversityApplicationName).trim()
      : null;
    
    let extractedText = rawExtractedText || extractedTextFromHtml || null;
    // IMPORTANT: Text extraction (including OCR) is async and handled by the `document_ingest` worker.

    const hasEnableAiField = rawEnableAi !== undefined;
    const enableAiRequested = rawEnableAi === 'true' || rawEnableAi === true;
    const skipParsingRequested = rawSkipParsing === 'true' || rawSkipParsing === true;

    // DOCUMENT_AI gating is enforced only when AI-dependent parsing is requested.
    // Baseline ingest (upload + text extraction) is allowed for all tiers by default.
    // Default: parse uploaded documents into profile sections unless the caller
    // explicitly opts out via skip_parsing / enable_ai=false. Create-profile
    // uploads (Organizations "Upload Form") historically omitted these flags and
    // silently stored files without section mapping.
    const shouldRunAi = skipParsingRequested
      ? false
      : hasEnableAiField
        ? enableAiRequested
        : true;

    const skipParsing = !shouldRunAi;
    const docType = rawType || (shouldRunAi ? 'source_material' : 'profile_file');
    const processingStatus = extractedText ? 'completed' : 'pending';

    // A local upload must remain usable after a deploy or an on-disk cleanup.
    // Persist the exact, security-validated bytes alongside their digest rather
    // than treating the public /uploads path as the durable authority. Re-read
    // after validation and compare the digest so a file changed between the
    // malware/type scan and persistence fails closed.
    let durableFileBytes = null
    let durableContentHash = null
    if (file?.path) {
      const durableUpload = await readValidatedUploadBytes(file)
      durableFileBytes = durableUpload.bytes
      durableContentHash = durableUpload.contentHash
    }

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
        file_url, file_path, file_size, mime_type, file_bytes, content_hash,
        extracted_text, processing_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const insertDocumentArgs = [
      docId,
      resolvedOrganizationId,
      rawGrantId || null,
      profileId,
      universityApplicationId,
      universityApplicationName,
      docName,
      docType,
      publicUrl,
      file?.path || null,
      durableFileBytes?.length || file?.size || null,
      file?.mimetype || null,
      durableFileBytes,
      durableContentHash,
      extractedText,
      processingStatus,
      rawNotes || null,
    ]

    try {
      await req.db.prepare(insertDocumentSql).run(...insertDocumentArgs)
    } catch (error) {
      // Clean up uploaded file if database insert fails
      if (file?.path) {
        try {
          fs.unlinkSync(file.path);
        } catch (unlinkError) {
          console.error('Failed to cleanup file after DB error:', unlinkError);
        }
      }
      
      const msg = String(error?.message || error)
      if (msg.includes('documents_status_check')) {
        // Retry without the status field — use a SQL variant that omits status entirely
        // so the DB default applies and avoids the constraint violation.
        // The documents_status_check constraint is on the `status` column.
        // Our INSERT does not include `status` at all, so this constraint
        // cannot fire from this INSERT. If it does fire, it means the schema
        // has a trigger or default that inserts a bad status value.
        // Retry by explicitly inserting without processing_status (let DB default apply).
        const insertNoStatusSql = `
          INSERT INTO documents (
            id, organization_id, grant_id, profile_id, university_application_id, university_application_name, name, type,
            file_url, file_path, file_size, mime_type, file_bytes, content_hash,
            extracted_text, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        // Build args without processing_status (index 15 in original insertDocumentArgs).
        const safeArgs = [
          ...insertDocumentArgs.slice(0, 15),
          insertDocumentArgs[16], // notes
        ]
        await req.db.prepare(insertNoStatusSql).run(...safeArgs)
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

      // "Automation is king": if this document satisfies something Hamilton was
      // waiting on, resolve it and auto-resume the task — uploading the doc
      // continues Hamilton on its own, just like supplying a missing field.
      // Best-effort: a Hamilton reconcile must never fail a document upload.
      try {
        const { reconcileProfileDocumentUploads } = await import('../services/hamilton/applicationTaskStore.js')
        await reconcileProfileDocumentUploads(req.db, { profileId, documentName: docName })
      } catch { /* never block an upload on the Hamilton reconcile */ }

      // Owner requirement (b): if this upload/URL is a COMPLETED application for a
      // known funding-source portal (e.g. a completed FAFSA link), mark that
      // portal complete-but-NOT-merged immediately — independent of whether the
      // async AI parse job runs (so URL imports + heuristics-only ingests are
      // covered too). The async worker runs the same detector again with the
      // worker-extracted text; both calls are idempotent. Best-effort.
      try {
        const { detectAndMarkCompletedApplications } = await import('../services/hamilton/portalCompletionDetector.js')
        await detectAndMarkCompletedApplications(req.db, {
          profileId,
          documentId: docId,
          grantId: rawGrantId || null,
          importUrl: typeof fileUrl === 'string' ? fileUrl : null,
          fileUrl: publicUrl || null,
          text: extractedText || '',
          fileName: docName || null,
        })
      } catch { /* never block an upload on portal-completion detection */ }
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

    const addToOpportunities = rawAddToOpportunities === true || rawAddToOpportunities === 'true';

    // Queue background ingestion:
    // - always extracts text (PDF/DOCX/TXT)
    // - OCR fallback for scanned PDFs + images
    // - AI parsing runs only if enable_ai is true (tier-gated)
    // - Also queues for HTML-imported docs when parsing is enabled or when add_to_opportunities (global Discover)
    const shouldQueue =
      (!extractedText && file?.path) ||
      (extractedTextFromHtml && !skipParsing && profileId) ||
      (extractedTextFromHtml && addToOpportunities && profileId);
    if (shouldQueue) {
      let enableAiForJob = !skipParsing
      if (!skipParsing && profileId) {
        const tierAllowed = await hasTierCapability(req.db, req, profileId, TIER_CAPABILITIES.DOCUMENT_AI)
        if (!tierAllowed) {
          enableAiForJob = false
          routeLogger.info('[documents/ingest] DOCUMENT_AI tier unavailable; queueing heuristics-only ingest', {
            profile_id: profileId,
            document_id: docId,
          })
        }
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
            enable_ai: enableAiForJob,
            add_to_opportunities: addToOpportunities,
          }),
          requestedBy,
        );
      
      const parseJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId);
      if (parseJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: parseJob.id,
          uploadDir: getUploadsDir(req),
          getOpenAI,
        });
      }
    }

    res.status(202).json({
      success: true,
      id: docId,
      profile_id: profileId,
      // Back-compat alias for some clients that expect camelCase.
      profileId: profileId,
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
    res.status(Number(error?.status) || 500).json({ error: error.message, code: error?.code || undefined });
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

    // Allowlist — MUST match schema.sql/documents.  Adding a new editable
    // field requires a reviewable code change so injection isn't possible
    // via surprise client-side keys.
    const DOCUMENT_MUTABLE_COLUMNS = new Set(['name', 'type', 'notes', 'status', 'processing_status'])
    const safeFields = fields.filter((f) => DOCUMENT_MUTABLE_COLUMNS.has(f))
    if (safeFields.length === 0) return res.status(400).json({ error: 'No valid fields provided' });
    // A revoked binding remains append-only audit evidence. Revocation removes
    // its proof authority; it does not make the underlying document editable.
    if (await manualSubmissionReceiptBinding(req.db, existing.id)) {
      return res.status(409).json({
        error: 'manual_submission_receipt_immutable',
        message: 'Manual submission receipt evidence remains immutable, including after revocation.',
      })
    }
    // Run each column name through ident() with the exact per-call-site
    // allowlist. This is defence in depth — a future refactor to the
    // filter above still can't smuggle a column name through the SQL.
    const safeSetClause = safeFields
      .map((f) => `${ident(f, DOCUMENT_MUTABLE_COLUMNS)} = ?`)
      .join(', ')
    const safeValues = safeFields.map((f) => req.body[f])
    await req.db
      .prepare(`UPDATE documents SET ${safeSetClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)`)
      .run(...safeValues, req.params.id, existing.profile_id ?? null);
    res.json(serializeDocument(await req.db
      .prepare(`SELECT ${DOCUMENT_METADATA_SELECT} FROM documents WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)`)
      .get(req.params.id, existing.profile_id ?? null)));
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
    if (!(await ensureDocumentDeleteAccess(req, res, context, existing))) return
    if (await manualSubmissionReceiptBinding(req.db, existing.id)) {
      return res.status(409).json({
        error: 'manual_submission_receipt_immutable',
        message: 'Manual submission receipt evidence remains immutable, including after revocation.',
      })
    }

    await req.db.prepare('DELETE FROM profile_documents WHERE document_id = ?').run(req.params.id);
    await req.db
      .prepare('DELETE FROM documents WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)')
      .run(req.params.id, existing.profile_id ?? null);

    // Also remove the backing file on disk so deleted documents don't leave
    // orphaned bytes accumulating on the persistent volume (/data/uploads).
    // Path-guarded to the uploads dirs and best-effort — a failed unlink must
    // not fail the delete (the nightly orphan sweep is the net).
    try {
      const resolved = resolveDocumentFilePath({ req, doc: existing });
      if (resolved.ok && resolved.path) {
        const target = String(resolved.path);
        const uploadsDir = getUploadsDir(req);
        const legacyUploadsDir = getLegacyUploadsDir(req);
        const insideUploads = [uploadsDir, legacyUploadsDir]
          .filter(Boolean)
          .some((base) => target === base || target.startsWith(base + sep));
        if (insideUploads) {
          await fs.promises.unlink(target).catch(() => { /* best-effort */ });
        }
      }
    } catch {
      // Never fail a document delete on disk cleanup.
    }

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
              uploadDir: getUploadsDir(req),
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
          uploadDir: getUploadsDir(req),
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
            // Dispatch the updated job so the worker picks up enable_ai=true.
            jobsToDispatch.push(already.id)
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
        uploadDir: getUploadsDir(req),
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
          uploadDir: getUploadsDir(req),
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
      // If the document already has extracted_text (e.g. HTML import via cheerio),
      // return a synthetic completed extract instead of misleading "pending" status.
      const fallbackText = (document.extracted_text || '').trim();
      if (fallbackText.length > 0) {
        const charCount = fallbackText.length;
        const wordCount = fallbackText.split(/\s+/).filter(Boolean).length;
        // Assign confidence based on text quality: >=500 chars → 0.85, >=100 → 0.7, else 0.5
        const confidence = charCount >= 500 ? 0.85 : charCount >= 100 ? 0.7 : 0.5;
        return res.json({
          document_id: document.id,
          status: 'completed',
          confidence,
          warnings: [],
          char_count: charCount,
          word_count: wordCount,
          pages: null,
          ocr_used: false,
          methods_used: ['html_scrape'],
          source_type: 'html',
        });
      }
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
