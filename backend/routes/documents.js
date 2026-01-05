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

function serializeSections(aiSections) {
  if (aiSections == null) return null;
  if (typeof aiSections === 'string') return aiSections;
  try {
    return JSON.stringify(aiSections);
  } catch {
    return null;
  }
}

router.get('/', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      return;
    }

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

    if (organization_id) {
      filters.push('organization_id = ?');
      params.push(organization_id);
    }
    if (grant_id) {
      filters.push('grant_id = ?');
      params.push(grant_id);
    }
    if (type) {
      filters.push('type = ?');
      params.push(type);
    }
    if (status) {
      filters.push('status = ?');
      params.push(status);
    }
    if (processing_status) {
      filters.push('processing_status = ?');
      params.push(processing_status);
    }

    if (context.isAdmin) {
      if (normalizedProfileId) {
        filters.push('profile_id = ?');
        params.push(normalizedProfileId);
      }
    } else {
      const accessible = Array.from(context.accessibleProfiles);
      if (accessible.length === 0) {
        return res.json([]);
      }
      if (normalizedProfileId) {
        if (!context.accessibleProfiles.has(normalizedProfileId)) {
          return res.json([]);
        }
        filters.push('profile_id = ?');
        params.push(normalizedProfileId);
      } else {
        const placeholders = accessible.map(() => '?').join(', ');
        filters.push(`profile_id IN (${placeholders})`);
        params.push(...accessible);
      }
    }

    let query = 'SELECT * FROM documents';
    if (filters.length > 0) {
      query += ` WHERE ${filters.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      return;
    }

    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, doc)) {
      return;
    }
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      return;
    }

    const id = crypto.randomUUID();
    const {
      organization_id: rawOrganizationId,
      grant_id,
      profile_id,
      name,
      type,
      file_url,
      file_path,
      file_size,
      mime_type,
      status = 'draft',
      notes = null,
      extracted_text = null,
      ai_summary = null,
      ai_sections = null,
      processing_status: rawProcessingStatus = null,
    } = req.body ?? {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const normalizedProfileId = normalizeProfileId(profile_id);
    let resolvedOrganizationId = rawOrganizationId ?? null;
    let profileRow = null;

    if (normalizedProfileId) {
      profileRow = req.db
        .prepare('SELECT id, organization_id FROM profiles WHERE id = ?')
        .get(normalizedProfileId);
      if (!profileRow) {
        return res.status(404).json({ error: 'Profile not found' });
      }
      if (!context.isAdmin && !context.accessibleProfiles.has(profileRow.id)) {
        return res.status(403).json({ error: 'Not authorized for this profile' });
      }
      if (!context.isAdmin || resolvedOrganizationId == null) {
        resolvedOrganizationId = profileRow.organization_id ?? null;
      }
    } else if (!context.isAdmin) {
      return res.status(400).json({ error: 'profile_id is required' });
    }

    const serializedSections = serializeSections(ai_sections);
    const effectiveProcessingStatus =
      rawProcessingStatus ??
      (extracted_text || file_url || file_path ? 'completed' : 'pending');

    req.db
      .prepare(
        `INSERT INTO documents (
            id,
            organization_id,
            grant_id,
            profile_id,
            name,
            type,
            file_url,
            file_path,
            file_size,
            mime_type,
            extracted_text,
            ai_summary,
            ai_sections,
            processing_status,
            status,
            notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        resolvedOrganizationId ?? null,
        grant_id ?? null,
        normalizedProfileId ?? null,
        name,
        type ?? null,
        file_url ?? null,
        file_path ?? null,
        file_size ?? null,
        mime_type ?? null,
        extracted_text ?? null,
        ai_summary ?? null,
        serializedSections,
        effectiveProcessingStatus,
        status,
        notes,
      );

    if (normalizedProfileId) {
      req.db
        .prepare(
          `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
        )
        .run(normalizedProfileId, id);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ingest', upload.single('document'), async (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
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
      display_name: rawDisplayName,
      primary_type: rawPrimaryType,
      skip_parsing: rawSkipParsing,
    } = req.body ?? {};

    const file = req.file;
    if (!file && !rawExtractedText && !req.body?.file_url) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const normalizedProfileId = normalizeProfileId(rawProfileId);
    const skipParsing = rawSkipParsing === 'true' || rawSkipParsing === true;
    let profileId = normalizedProfileId;
    let createdProfile = null;
    let resolvedOrganizationId = rawOrganizationId ?? null;

    if (profileId) {
      const profile = req.db
        .prepare('SELECT id, organization_id FROM profiles WHERE id = ?')
        .get(profileId);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }
      if (!context.isAdmin && !context.accessibleProfiles.has(profile.id)) {
        return res.status(403).json({ error: 'Not authorized for this profile' });
      }
      if (!context.isAdmin || resolvedOrganizationId == null) {
        resolvedOrganizationId = profile.organization_id ?? null;
      }
    } else {
      if (!context.isAdmin) {
        return res.status(403).json({ error: 'Profile is required for uploads' });
      }
      const generatedProfileId = crypto.randomUUID();
      const displayNameSource = rawDisplayName || file?.originalname || 'New Profile';
      const displayName = displayNameSource?.replace(/\.[^/.]+$/, '').trim() || 'New Profile';
      const primaryType = rawPrimaryType || null;

      req.db
        .prepare(
          `INSERT INTO profiles (
            id,
            display_name,
            primary_type,
            status,
            organization_id,
            tags
          ) VALUES (?, ?, ?, 'pending', ?, '[]')`
        )
        .run(generatedProfileId, displayName, primaryType, resolvedOrganizationId ?? null);

      profileId = generatedProfileId;
      createdProfile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
      resolvedOrganizationId = createdProfile?.organization_id ?? resolvedOrganizationId ?? null;
    }

    linkProfileToAdmin(req.db, profileId);

    const storedFilePath = file ? file.path : null;
    const publicUrl = file ? `/uploads/${file.filename}` : req.body?.file_url ?? null;
    const inferredFileName = file?.originalname || req.body?.file_name || rawName || 'Uploaded Document';
    const docName = inferredFileName.trim();

    let extracted_text = rawExtractedText || null;
    if (!extracted_text && storedFilePath && file?.mimetype) {
      extracted_text = await extractTextFromFile(storedFilePath, file.mimetype);
    }

    const processingStatusValue =
      skipParsing || extracted_text ? 'completed' : 'pending';

    const id = crypto.randomUUID();
    req.db
      .prepare(
        `INSERT INTO documents (
          id,
          organization_id,
          grant_id,
          profile_id,
          name,
          type,
          file_url,
          file_path,
          file_size,
          mime_type,
          extracted_text,
          processing_status,
          status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        id,
        resolvedOrganizationId ?? null,
        rawGrantId ?? null,
        profileId,
        docName,
        rawType ?? null,
        publicUrl,
        storedFilePath,
        file?.size ?? null,
        file?.mimetype ?? null,
        extracted_text,
        processingStatusValue,
        rawNotes ?? null,
        rawNotes ?? null,
      );

    req.db
      .prepare(
        `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
      )
      .run(profileId, id);

    if (!skipParsing) {
      const parameters = JSON.stringify({
        document_id: id,
        source,
      });

      const requestedBy = req.user?.profileId ?? req.user?.userId ?? 'system';

      req.db
        .prepare(
          `INSERT INTO crawler_jobs (
            type,
            status,
            profile_id,
            organization_id,
            parameters,
            requested_by
          ) VALUES ('document_ingest', 'queued', ?, ?, ?, ?)`
        )
        .run(profileId, resolvedOrganizationId ?? null, parameters, requestedBy);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(202).json({
      ...document,
      profile_id: profileId,
      created_profile: createdProfile ?? undefined,
      parsing_skipped: skipParsing,
    });
  } catch (error) {
    console.error('Document ingestion enqueue failed:', error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Failed to remove uploaded file after error', unlinkError);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
      return;
    }

    const existing = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!ensureDocumentAccess(res, context, existing)) {
      return;
    }

    const fields = Object.keys(req.body ?? {});
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided' });
    }

    if (!context.isAdmin) {
      if (fields.includes('profile_id') && req.body.profile_id !== existing.profile_id) {
        return res.status(403).json({ error: 'Cannot reassign document to another profile' });
      }
      if (fields.includes('organization_id') && req.body.organization_id !== existing.organization_id) {
        return res.status(403).json({ error: 'Cannot change organization for this document' });
      }
    }

    const values = Object.values(req.body);
    const setClause = fields.map((f) => `${f} = ?`).join(', ');
    req.db
      .prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, req.params.id);
    res.json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


router.get('/', (req, res) => {
  try {
    const { organization_id, grant_id, profile_id, type, status, processing_status } = req.query;
    let query = 'SELECT * FROM documents WHERE 1=1';
    const params = [];
    if (organization_id) { query += ' AND organization_id = ?'; params.push(organization_id); }
    if (grant_id) { query += ' AND grant_id = ?'; params.push(grant_id); }
    if (profile_id) { query += ' AND profile_id = ?'; params.push(profile_id); }
    if (type) { query += ' AND type = ?'; params.push(type); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (processing_status) { query += ' AND processing_status = ?'; params.push(processing_status); }
    query += ' ORDER BY created_at DESC';
    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const {
      organization_id,
      grant_id,
      profile_id,
      name,
      type,
      file_url,
      file_path,
      file_size,
      mime_type,
      status = 'draft',
      notes = null,
    } = req.body ?? {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    req.db
      .prepare(
        `INSERT INTO documents (
            id,
            organization_id,
            grant_id,
            profile_id,
            name,
            type,
            file_url,
            file_path,
            file_size,
            mime_type,
            status,
            notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        organization_id ?? null,
        grant_id ?? null,
        profile_id ?? null,
        name,
        type ?? null,
        file_url ?? null,
        file_path ?? null,
        file_size ?? null,
        mime_type ?? null,
        status,
        notes,
      );

    if (profile_id) {
      req.db
        .prepare(
          `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
        )
        .run(profile_id, id);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ingest', upload.single('document'), async (req, res) => {
  try {
    const context = buildAccessContext(req);
    if (!ensureAuthenticated(res, context)) {
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
      display_name: rawDisplayName,
      primary_type: rawPrimaryType,
      skip_parsing: rawSkipParsing,
    } = req.body ?? {};

    const file = req.file;
    if (!file && !rawExtractedText && !req.body?.file_url) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const grantId = rawGrantId || null;
    const documentType = rawType || null;
    const notes = rawNotes || null;
    const skipParsing = rawSkipParsing === 'true' || rawSkipParsing === true;
    let profileId = normalizeProfileId(rawProfileId);
    let resolvedOrganizationId = rawOrganizationId ?? null;
    let createdProfile = null;

    if (profileId) {
      const profileRow = req.db
        .prepare('SELECT id, organization_id FROM profiles WHERE id = ?')
        .get(profileId);
      if (!profileRow) {
        return res.status(404).json({ error: 'Profile not found' });
      }
      if (!context.isAdmin && !context.accessibleProfiles.has(profileRow.id)) {
        return res.status(403).json({ error: 'Not authorized for this profile' });
      }
      if (!context.isAdmin || resolvedOrganizationId == null) {
        resolvedOrganizationId = profileRow.organization_id ?? null;
      }
    } else {
      if (!context.isAdmin) {
        return res.status(403).json({ error: 'Profile is required for uploads' });
      }
      const generatedProfileId = crypto.randomUUID();
      const displayNameSource = rawDisplayName || file?.originalname || 'New Profile';
      const displayName = displayNameSource?.replace(/\.[^/.]+$/, '').trim() || 'New Profile';
      const primaryType = rawPrimaryType || null;

      req.db
        .prepare(
          `INSERT INTO profiles (
            id,
            display_name,
            primary_type,
            status,
            organization_id,
            tags
          ) VALUES (?, ?, ?, 'pending', ?, '[]')`
        )
        .run(generatedProfileId, displayName, primaryType, resolvedOrganizationId ?? null);

      profileId = generatedProfileId;
      createdProfile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
      resolvedOrganizationId = createdProfile?.organization_id ?? resolvedOrganizationId ?? null;
    }

    linkProfileToAdmin(req.db, profileId);

    const storedFilePath = file ? file.path : null;
    const publicUrl = file ? `/uploads/${file.filename}` : req.body?.file_url ?? null;
    const inferredFileName = file?.originalname || req.body?.file_name || rawName || 'Uploaded Document';
    const docName = inferredFileName.trim();

    let extractedText = rawExtractedText || null;
    if (!extractedText && storedFilePath && file?.mimetype) {
      extractedText = await extractTextFromFile(storedFilePath, file.mimetype);
    }

    const processingStatusValue = skipParsing || extractedText ? 'completed' : 'pending';

    const id = crypto.randomUUID();
    req.db
      .prepare(
        `INSERT INTO documents (
          id,
          organization_id,
          grant_id,
          profile_id,
          name,
          type,
          file_url,
          file_path,
          file_size,
          mime_type,
          extracted_text,
          processing_status,
          status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        id,
        resolvedOrganizationId ?? null,
        grantId ?? null,
        profileId,
        docName,
        documentType,
        publicUrl,
        storedFilePath,
        file?.size ?? null,
        file?.mimetype ?? null,
        extractedText,
        processingStatusValue,
        notes,
      );

    req.db
      .prepare(
        `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
      )
      .run(profileId, id);

    if (!skipParsing) {
      const parameters = JSON.stringify({
        document_id: id,
        source,
      });

      const requestedBy = req.user?.profileId ?? req.user?.userId ?? 'system';

      req.db
        .prepare(
          `INSERT INTO crawler_jobs (
            type,
            status,
            profile_id,
            organization_id,
            parameters,
            requested_by
          ) VALUES ('document_ingest', 'queued', ?, ?, ?, ?)`
        )
        .run(profileId, resolvedOrganizationId ?? null, parameters, requestedBy);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(202).json({
      ...document,
      profile_id: profileId,
      created_profile: createdProfile ?? undefined,
      parsing_skipped: skipParsing,
    });
  } catch (error) {
    console.error('Document ingestion enqueue failed:', error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Failed to remove uploaded file after error', unlinkError);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    req.db.prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    res.json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEW: Endpoint to manually trigger document parsing
router.post('/:id/parse', (req, res) => {
  try {
    const docId = req.params.id;
    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Check if already being parsed or completed
    const existingJob = req.db.prepare(
      `SELECT * FROM crawler_jobs 
       WHERE type = 'document_ingest' 
       AND parameters LIKE ?
       AND status IN ('queued', 'running')
       LIMIT 1`
    ).get(`%"document_id":"${docId}"%`);

    if (existingJob) {
      return res.status(409).json({ 
        error: 'Document is already being parsed',
        job_id: existingJob.id,
        status: existingJob.status
      });
    }

    // Create new parsing job
    const parameters = JSON.stringify({
      document_id: docId,
      source: req.body.source || 'manual',
    });

    const requestedBy = req.user?.profileId ?? req.user?.userId ?? 'system';

    req.db
      .prepare(
        `INSERT INTO crawler_jobs (
          type,
          status,
          profile_id,
          organization_id,
          parameters,
          requested_by
        ) VALUES ('document_ingest', 'queued', ?, ?, ?, ?)`
      )
      .run(doc.profile_id, doc.organization_id ?? null, parameters, requestedBy);

    // Update document status
    req.db.prepare(
      `UPDATE documents SET processing_status = 'pending' WHERE id = ?`
    ).run(docId);

    res.json({ 
      success: true, 
      message: 'Document parsing queued',
      document_id: docId
    });
  } catch (error) {
    console.error('Error queuing document parsing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('DELETE FROM profile_documents WHERE document_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload endpoint for Base44 SDK compatibility
router.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const publicUrl = `/uploads/${file.filename}`;
    
    res.json({
      file_url: publicUrl,
      file_name: file.originalname,
      file_size: file.size,
      mime_type: file.mimetype,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Failed to remove uploaded file after error', unlinkError);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

// Create signed URL endpoint for Base44 SDK compatibility
const SIGNED_URL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

router.post('/signed-url', (req, res) => {
  try {
    const { file_uri } = req.body;
    
    if (!file_uri) {
      return res.status(400).json({ error: 'file_uri is required' });
    }

    // NOTE: In production with cloud storage (S3, GCS), this would generate time-limited signed URLs
    // Currently, files are served statically and remain accessible beyond expiry time
    // The expires_at field is informational only and does not enforce access restrictions
    let signed_url;
    
    if (file_uri.startsWith('http://') || file_uri.startsWith('https://')) {
      // Already a full URL
      signed_url = file_uri;
    } else if (file_uri.startsWith('/uploads/')) {
      // Relative path to uploads - make it absolute
      const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 8080}`;
      signed_url = `${baseUrl}${file_uri}`;
    } else {
      // Assume it's a relative path and prepend the base URL
      const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 8080}`;
      signed_url = `${baseUrl}/uploads/${file_uri}`;
    }
    
    res.json({
      signed_url,
      expires_at: new Date(Date.now() + SIGNED_URL_EXPIRY_MS).toISOString(),
    });
  } catch (error) {
    console.error('Error creating signed URL:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
