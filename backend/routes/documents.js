import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
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
      skip_parsing: rawSkipParsing, // NEW: Optional parameter to skip auto-parsing
    } = req.body ?? {};

    const file = req.file;
    if (!file && !rawExtractedText && !req.body?.file_url) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const organization_id = rawOrganizationId || null;
    const grant_id = rawGrantId || null;
    const type = rawType || null;
    const notes = rawNotes || null;
    const skipParsing = rawSkipParsing === 'true' || rawSkipParsing === true; // Parse boolean

    let profileId = rawProfileId || null;
    let createdProfile = null;

    if (profileId) {
      const profile = req.db
        .prepare('SELECT id FROM profiles WHERE id = ?')
        .get(profileId);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }
    } else {
      const generatedProfileId = crypto.randomUUID();
      const displayNameSource = rawDisplayName || file.originalname || 'New Profile';
      const displayName = displayNameSource.replace(/\.[^/.]+$/, '').trim() || 'New Profile';
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
        .run(generatedProfileId, displayName, primaryType, organization_id ?? null);

      profileId = generatedProfileId;
      createdProfile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    }

    linkProfileToAdmin(req.db, profileId);

    const storedFilePath = file ? file.path : null;
    const publicUrl = file ? `/uploads/${file.filename}` : (req.body?.file_url ?? null);
    const inferredFileName = file?.originalname || req.body?.file_name || rawName || 'Uploaded Document';
    const docName = inferredFileName.trim();

    let extracted_text = rawExtractedText || null;
    if (!extracted_text && storedFilePath && file?.mimetype) {
      extracted_text = await extractTextFromFile(storedFilePath, file.mimetype);
    }

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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'draft', ?)`
      )
      .run(
        id,
        organization_id ?? null,
        grant_id ?? null,
        profileId,
        docName,
        type,
        publicUrl,
        storedFilePath,
        file.size ?? null,
        file.mimetype ?? null,
        extracted_text,
        notes,
      );

    req.db
      .prepare(
        `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
      )
      .run(profileId, id);

    // FIXED: Only queue parsing job if skip_parsing is not true
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
        .run(profileId, organization_id ?? null, parameters, requestedBy);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(202).json({
      ...document,
      profile_id: profileId,
      created_profile: createdProfile ?? undefined,
      parsing_skipped: skipParsing, // Inform client that parsing was skipped
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

export default router;
