import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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

router.post('/ingest', upload.single('document'), (req, res) => {
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
    } = req.body ?? {};

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'document file is required' });
    }

    const organization_id = rawOrganizationId || null;
    const grant_id = rawGrantId || null;
    const type = rawType || null;
    const notes = rawNotes || null;
    const extracted_text = rawExtractedText || null;

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

    const storedFilePath = file.path;
    const publicUrl = `/uploads/${file.filename}`;
    const docName = (rawName || file.originalname || 'Uploaded Document').trim();

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

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(202).json({
      ...document,
      profile_id: profileId,
      created_profile: createdProfile ?? undefined,
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
